import React, { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";



// ===================== Utilidades de fecha y formato =====================
const tz = "America/Bogota";
const fmtDate = (iso) => new Date(iso).toLocaleDateString("es-CO", { timeZone: tz });
const todayISO = () => new Date().toISOString();
const parseNumber = (v) => {
  // Acepta coma o punto como separador decimal
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

// ===================== Almacenamiento =====================
const STORAGE_KEY = "anncor_weighings_v1";

// Genera UUID compatible con navegadores que no soporten crypto.randomUUID
function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function App() {
  // ===================== Estado principal =====================
  const [records, setRecords] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      // Sanitizar tipos (por si se guardaron como strings)
      return parsed.map((r) => ({ ...r, weightKg: parseNumber(r.weightKg) }));
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState({ dateISO: todayISO(), pigId: "", weightKg: "" });
  const [filterPig, setFilterPig] = useState("");
  const [showTests, setShowTests] = useState(false);
  const [testResults, setTestResults] = useState([]);

  // Guardar automáticamente
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }, [records]);

  // IDs únicos y registros filtrados
  const uniquePigIds = useMemo(() => Array.from(new Set(records.map((r) => r.pigId))).sort(), [records]);

  const filtered = useMemo(() => {
    if (!filterPig) return [...records].sort(sortByPigThenDate);
    return records.filter((r) => r.pigId === filterPig).sort(sortByDate);
  }, [records, filterPig]);

  // Cálculo de aumentos secuenciales por cerdo
  const enriched = useMemo(() => withDeltas(filtered), [filtered]);

  // Ganancias por último pesaje (vista resumen por cerdo)
  const latestPerPig = useMemo(() => computeLatestPerPig(withDeltas(records)), [records]);

  // ===================== Manejo de formulario =====================
  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleAdd = (e) => {
    e.preventDefault();
    const pigId = String(form.pigId).trim();
    const weightKg = parseNumber(form.weightKg);
    const d = form.dateISO ? new Date(form.dateISO) : new Date();
    if (!pigId) return alert("Ingresa el ID del cerdo");
    if (weightKg <= 0) return alert("Ingresa un peso válido (> 0)");
    const dateISO = d.toISOString();

    const newRec = { id: uuid(), dateISO, pigId, weightKg };
    setRecords((rs) => [...rs, newRec]);
    setForm((f) => ({ ...f, weightKg: "" }));
  };

  const handleDelete = (id) => {
    if (!confirm("¿Eliminar este registro?")) return;
    setRecords((rs) => rs.filter((r) => r.id !== id));
  };

  const handleClearAll = () => {
    if (!confirm("Esto borrará TODOS los registros locales. ¿Continuar?")) return;
    setRecords([]);
  };

  // ===================== Exportar PDF (todo o filtrado) =====================
  const exportPDF = (scope = "all") => {
    const source = scope === "filtered" ? enriched : withDeltas(records.sort(sortByPigThenDate));
    if (source.length === 0) {
      alert("No hay registros para exportar.");
      return;
    }

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const title = scope === "filtered" && filterPig ? `Pesajes – Cerdo ${filterPig}` : "Pesajes – ANNCOR";

    // ===== Agregar imagen arriba a la derecha =====
    try {
      const pageWidth = doc.internal.pageSize.getWidth();
      // ruta a la imagen en carpeta public
      doc.addImage("/ancordfot.png", "PNG", pageWidth - 100, 20, 80, 40);
    } catch (e) {
      console.warn("No se pudo agregar la imagen:", e);
    }

    doc.setFontSize(16);
    doc.text(title, 40, 40);
    doc.setFontSize(10);
    doc.text(`Generado: ${new Date().toLocaleString("es-CO", { timeZone: tz })}`, 40, 58);

    const head = [["Fecha", "ID Cerdo", "Peso (kg)", "Δ vs. anterior (kg)"]];
    const body = source.map((r) => [fmtDate(r.dateISO), r.pigId, toFixed1(r.weightKg), toDeltaStr(r.deltaKg)]);

    try {
      autoTable(doc, {
        head,
        body,
        startY: 80,
        styles: { fontSize: 10, cellPadding: 6 },
        headStyles: { halign: "center" },
        columnStyles: {
          0: { halign: "left" },
          1: { halign: "center" },
          2: { halign: "right" },
          3: { halign: "right" },
        },
        didDrawPage: () => {
          const pageSize = doc.internal.pageSize;
          const pageHeight = pageSize.height ? pageSize.height : pageSize.getHeight();
          doc.setFontSize(9);
          doc.text("ANNCOR • Sistema de Pesajes", 40, pageHeight - 20);
        },
      });
    } catch (err) {
      console.error("Fallo autoTable, exportando lista simple:", err);
      let y = 90;
      doc.setFontSize(12);
      doc.text("Fecha | ID | Peso (kg) | Δ (kg)", 40, 80);
      doc.setFontSize(10);
      for (const r of source) {
        doc.text(`${fmtDate(r.dateISO)} | ${r.pigId} | ${toFixed1(r.weightKg)} | ${toDeltaStr(r.deltaKg)}`.trim(), 40, y);
        y += 16;
      }
    }

    doc.save(
      scope === "filtered" && filterPig
        ? `Pesajes_${sanitizeFileName(filterPig)}.pdf`
        : `Pesajes_ANNCOR.pdf`
    );
  };

  // ===================== Pruebas (QA) =====================
  useEffect(() => {
    // Ejecuta pruebas al cargar por primera vez
    setTestResults(runTests());
  }, []);

  const rerunTests = () => setTestResults(runTests());

  // ===================== UI =====================
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-3 sm:p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold">ANNCOR • Pesaje de Cerdos</h1>
            <p className="text-sm text-neutral-600">Registro de pesajes por ID, cálculo de aumento y exportación PDF. (MVP offline)</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportPDF("all")} className="px-3 py-2 rounded-2xl shadow bg-neutral-900 text-white text-sm">Exportar PDF (Todos)</button>
            <button onClick={() => exportPDF("filtered")} className="px-3 py-2 rounded-2xl shadow border text-sm">PDF (Filtro)</button>
          </div>
        </header>

        {/* Formulario de alta */}
        <section className="bg-white rounded-2xl shadow p-4 mb-4">
          <h2 className="text-lg font-semibold mb-3">Nuevo pesaje</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div className="flex flex-col">
              <label className="text-sm mb-1">Fecha</label>
              <input
                type="datetime-local"
                name="dateISO"
                value={toLocalInputValue(form.dateISO)}
                onChange={(e) => {
                  const val = e.target.value;
                  const iso = val ? new Date(val).toISOString() : todayISO();
                  setForm((f) => ({ ...f, dateISO: iso }));
                }}
                className="border rounded-xl px-3 py-2"
                required
              />
            </div>
            <div className="flex flex-col">
              <label className="text-sm mb-1">ID del cerdo</label>
              <input
                type="text"
                name="pigId"
                placeholder="Ej: Lote-12 / 045"
                value={form.pigId}
                onChange={handleChange}
                className="border rounded-xl px-3 py-2"
                required
              />
            </div>
            <div className="flex flex-col">
              <label className="text-sm mb-1">Peso (kg)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                name="weightKg"
                placeholder="Ej: 23.5"
                value={form.weightKg}
                onChange={handleChange}
                className="border rounded-xl px-3 py-2"
                required
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="px-4 py-2 rounded-2xl bg-emerald-600 text-white shadow w-full">Agregar</button>
            </div>
          </form>
        </section>

        {/* Filtros */}
        <section className="bg-white rounded-2xl shadow p-4 mb-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label className="text-sm">Filtrar por ID:</label>
              <input
                className="border rounded-xl px-3 py-2 w-full sm:w-60"
                placeholder="Escribe o selecciona…"
                list="pig-ids"
                value={filterPig}
                onChange={(e) => setFilterPig(e.target.value)}
              />
              <datalist id="pig-ids">
                {uniquePigIds.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              {filterPig && (
                <button onClick={() => setFilterPig("")} className="text-sm underline">Limpiar</button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleClearAll} className="px-3 py-2 rounded-2xl border text-sm">Borrar todo</button>
              <button onClick={() => setShowTests((s) => !s)} className="px-3 py-2 rounded-2xl border text-sm">{showTests ? "Ocultar pruebas" : "Ver pruebas"}</button>
            </div>
          </div>

          {showTests && (
            <div className="mt-3 border rounded-xl p-3 bg-neutral-50">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold">Pruebas (QA)</h3>
                <button onClick={rerunTests} className="text-sm underline">Re-ejecutar</button>
              </div>
              <ul className="text-sm space-y-1">
                {testResults.map((t, i) => (
                  <li key={i} className={t.pass ? "text-emerald-700" : "text-red-700"}>
                    {t.pass ? "✔" : "✘"} {t.name} — obtenido: {String(t.got)} | esperado: {String(t.want)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Resumen por cerdo (último pesaje) */}
        <section className="bg-white rounded-2xl shadow p-4 mb-4">
          <h2 className="text-lg font-semibold mb-3">Resumen (último pesaje por cerdo)</h2>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-2">ID</th>
                  <th className="py-2 pr-2">Fecha</th>
                  <th className="py-2 pr-2 text-right">Peso (kg)</th>
                  <th className="py-2 pr-2 text-right">Δ último (kg)</th>
                </tr>
              </thead>
              <tbody>
                {latestPerPig.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-2 font-medium">{r.pigId}</td>
                    <td className="py-2 pr-2">{fmtDate(r.dateISO)}</td>
                    <td className="py-2 pr-2 text-right">{toFixed1(r.weightKg)}</td>
                    <td className={`py-2 pr-2 text-right ${deltaClass(r.deltaKg)}`}>{toDeltaStr(r.deltaKg)}</td>
                  </tr>
                ))}
                {latestPerPig.length === 0 && (
                  <tr><td className="py-3 text-neutral-500" colSpan={4}>Sin datos aún.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Historial detallado */}
        <section className="bg-white rounded-2xl shadow p-4 mb-10">
          <h2 className="text-lg font-semibold mb-3">Historial (ordenado {filterPig ? "por fecha" : "por ID y fecha"})</h2>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-2">Fecha</th>
                  <th className="py-2 pr-2">ID</th>
                  <th className="py-2 pr-2 text-right">Peso (kg)</th>
                  <th className="py-2 pr-2 text-right">Δ vs. anterior (kg)</th>
                  <th className="py-2 pr-2 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-2">{fmtDate(r.dateISO)}</td>
                    <td className="py-2 pr-2">{r.pigId}</td>
                    <td className="py-2 pr-2 text-right">{toFixed1(r.weightKg)}</td>
                    <td className={`py-2 pr-2 text-right ${deltaClass(r.deltaKg)}`}>{toDeltaStr(r.deltaKg)}</td>
                    <td className="py-2 pr-2 text-right">
                      <button onClick={() => handleDelete(r.id)} className="text-red-600 underline">Eliminar</button>
                    </td>
                  </tr>
                ))}
                {enriched.length === 0 && (
                  <tr><td className="py-3 text-neutral-500" colSpan={5}>No hay registros para mostrar.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

// ===================== Helpers =====================
function sortByDate(a, b) {
  return new Date(a.dateISO) - new Date(b.dateISO);
}
function sortByPigThenDate(a, b) {
  if (a.pigId === b.pigId) return sortByDate(a, b);
  return a.pigId.localeCompare(b.pigId, "es");
}
function toFixed1(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1);
}
function toDeltaStr(d) {
  if (d == null) return "–";
  const sign = d > 0 ? "+" : d < 0 ? "" : "±";
  return `${sign}${toFixed1(d)}`;
}
function deltaClass(d) {
  if (d == null) return "text-neutral-500";
  if (d > 0) return "text-emerald-700";
  if (d < 0) return "text-red-700";
  return "text-neutral-700";
}
function withDeltas(recs) {
  // Calcula delta vs. pesaje anterior para cada cerdo, conservando orden de entrada
  const byPig = new Map();
  const sorted = [...recs].sort(sortByPigThenDate);
  const out = [];
  for (const r of sorted) {
    const prev = byPig.get(r.pigId);
    const deltaKg = prev ? r.weightKg - prev.weightKg : null;
    out.push({ ...r, deltaKg });
    byPig.set(r.pigId, r);
  }
  // Por defecto retornamos ordenados por cerdo/fecha
  return out;
}
function computeLatestPerPig(recsWithDeltas) {
  const sorted = [...recsWithDeltas].sort(sortByPigThenDate);
  const byPig = new Map();
  for (const r of sorted) byPig.set(r.pigId, r); // el último por pigId
  return Array.from(byPig.values()).sort((a, b) => a.pigId.localeCompare(b.pigId, "es"));
}
function sanitizeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9-_\.]/g, "_");
}
function toLocalInputValue(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const da = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${y}-${m}-${da}T${hh}:${mm}`;
  } catch {
    return "";
  }
}

// ===================== Test Cases =====================
function runTests() {
  const tests = [];
  const push = (name, got, want) => tests.push({ name, got, want, pass: deepEq(got, want) });

  // parseNumber
  push("parseNumber con punto", parseNumber("23.5"), 23.5);
  push("parseNumber con coma", parseNumber("23,5"), 23.5);
  push("parseNumber inválido", parseNumber("abc"), 0);

  // toFixed1
  push("toFixed1 redondeo", toFixed1(12.34), "12.3");
  push("toFixed1 redondeo .05", toFixed1(1.05), "1.1");

  // toDeltaStr
  push("toDeltaStr positivo", toDeltaStr(2.345), "+2.3");
  push("toDeltaStr cero", toDeltaStr(0), "±0.0");
  push("toDeltaStr null", toDeltaStr(null), "–");

  // withDeltas y computeLatestPerPig
  const sample = [
    { id: "1", dateISO: "2025-01-01T00:00:00.000Z", pigId: "A", weightKg: 10 },
    { id: "2", dateISO: "2025-01-02T00:00:00.000Z", pigId: "A", weightKg: 11.2 },
    { id: "3", dateISO: "2025-01-01T00:00:00.000Z", pigId: "B", weightKg: 9.7 },
    { id: "4", dateISO: "2025-01-03T00:00:00.000Z", pigId: "A", weightKg: 12.0 },
    { id: "5", dateISO: "2025-01-02T00:00:00.000Z", pigId: "B", weightKg: 10.0 },
  ];
  const deltas = withDeltas(sample);
  const aRecs = deltas.filter((r) => r.pigId === "A").sort(sortByDate);
  const bRecs = deltas.filter((r) => r.pigId === "B").sort(sortByDate);
  push("delta A[0] = null", aRecs[0].deltaKg == null, true);
  push("delta A[1] = 1.2", Number(aRecs[1].deltaKg.toFixed(1)), 1.2);
  push("delta A[2] = 0.8", Number(aRecs[2].deltaKg.toFixed(1)), 0.8);
  push("delta B[0] = null", bRecs[0].deltaKg == null, true);
  push("delta B[1] = 0.3", Number(bRecs[1].deltaKg.toFixed(1)), 0.3);

  const latest = computeLatestPerPig(deltas);
  // Últimos deben ser A@2025-01-03 y B@2025-01-02
  const latestA = latest.find((r) => r.pigId === "A");
  const latestB = latest.find((r) => r.pigId === "B");
  push("latest A fecha", latestA.dateISO, "2025-01-03T00:00:00.000Z");
  push("latest B fecha", latestB.dateISO, "2025-01-02T00:00:00.000Z");

  return tests;
}

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEq(a[k], b[k])) return false;
    return true;
  }
  return false;
}
