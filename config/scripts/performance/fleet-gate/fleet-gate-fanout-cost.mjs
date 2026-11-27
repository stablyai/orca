// Measurement only: reads the instrumented build's per-write and per-reader store costs.
export function resetFanoutCost(page) {
  return page.evaluate(() => {
    const f = globalThis.__orcaFanout
    if (f) {
      f.writes = []
      f.readers.clear()
      f.raw.clear()
    }
  })
}

export function readFanoutCost(page) {
  return page.evaluate(() => {
    const f = globalThis.__orcaFanout
    if (!f) {
      return null
    }
    const r2 = (v) => Math.round(v * 100) / 100
    const ms = f.writes.map((w) => w.ms).sort((a, b) => a - b)
    const at = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0)
    const byKeys = new Map()
    for (const w of f.writes) {
      const row = byKeys.get(w.keys) ?? { n: 0, ms: 0 }
      row.n += 1
      row.ms += w.ms
      byKeys.set(w.keys, row)
    }
    const top = (map, n) =>
      [...map.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, n)
        .map(([key, row]) => ({
          key: key.slice(0, 220),
          ms: r2(row.ms),
          calls: row.calls ?? row.n,
          changed: row.changed
        }))
    const readerTotal = [...f.readers.values()].reduce((s, r) => s + r.ms, 0)
    const readerCalls = [...f.readers.values()].reduce((s, r) => s + r.calls, 0)
    const rawTotal = [...f.raw.values()].reduce((s, r) => s + r.ms, 0)
    return {
      writes: ms.length,
      totalMs: r2(ms.reduce((s, v) => s + v, 0)),
      p50: r2(at(0.5)),
      p95: r2(at(0.95)),
      max: r2(at(1)),
      meanListeners: Math.round(
        f.writes.reduce((s, w) => s + w.listeners, 0) / Math.max(1, f.writes.length)
      ),
      readerMs: r2(readerTotal),
      readerCalls,
      distinctReaders: f.readers.size,
      rawMs: r2(rawTotal),
      topWrites: top(byKeys, 8),
      topReaders: top(f.readers, 30),
      topRaw: top(f.raw, 12)
    }
  })
}
