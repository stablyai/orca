// Measurement only: per-window fanout counters the instrumented build writes into the page.
export function resetFanoutStats(page) {
  return page.evaluate(() => {
    const g = globalThis
    if (g.__orcaDispatch) {
      g.__orcaDispatch.timings = []
    }
    g.__orcaActivity = { builds: 0, visits: 0, rebuilt: 0, batches: [] }
    g.__orcaLongTasks = []
  })
}

export function readFanoutStats(page) {
  return page.evaluate(() => {
    const g = globalThis
    const timings = g.__orcaDispatch?.timings ?? []
    const byKind = {}
    for (const { kind, ms } of timings) {
      ;(byKind[kind] ??= []).push(ms)
    }
    const stats = {}
    for (const [kind, values] of Object.entries(byKind)) {
      values.sort((a, b) => a - b)
      const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))]
      stats[kind] = {
        n: values.length,
        totalMs: Math.round(values.reduce((sum, v) => sum + v, 0)),
        p50: +at(0.5).toFixed(2),
        p95: +at(0.95).toFixed(2),
        max: +values.at(-1).toFixed(2)
      }
    }
    const activity = g.__orcaActivity ?? null
    let projection = null
    if (activity?.batches?.length) {
      const batches = activity.batches
      const ms = batches.map((b) => b.ms).sort((a, b) => a - b)
      const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]
      const longs = g.__orcaLongTasks ?? []
      let overlapping = 0
      let attributed = 0
      for (const task of longs) {
        const inside = batches
          .filter((b) => b.start >= task.start && b.start < task.start + task.ms)
          .reduce((sum, b) => sum + b.ms, 0)
        if (inside > 0) {
          overlapping += 1
        }
        if (inside >= 25) {
          attributed += 1
        }
      }
      projection = {
        n: ms.length,
        p50: +at(0.5).toFixed(2),
        p95: +at(0.95).toFixed(2),
        max: +ms.at(-1).toFixed(2),
        totalMs: Math.round(ms.reduce((s, v) => s + v, 0)),
        longTasks: longs.length,
        longTasksOverlapping: overlapping,
        longTasksAttributed: attributed
      }
      delete activity.batches
    }
    return { dispatch: stats, activity, projection }
  })
}
