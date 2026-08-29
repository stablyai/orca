const RENDERER_TIMER_INTERVAL_MS = 100

export async function startRendererTimingProbe(page) {
  await page.evaluate((timerIntervalMs) => {
    const maxSamples = 5_000
    const maxEntries = 80
    let phaseStartedAt = performance.now()
    let phaseStartedAtIso = new Date().toISOString()
    let timerId = null
    let driftCount = 0
    let driftSamples = []
    let longTaskEntries = []
    let observer = null
    let longTaskSupported = false

    const round = (value) => Math.round(value * 100) / 100
    const summarize = (values, totalCount = values.length) => {
      const sorted = [...values].sort((left, right) => left - right)
      const percentile = (fraction) =>
        sorted.length === 0
          ? null
          : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
      return {
        count: totalCount,
        retainedCount: sorted.length,
        mean:
          sorted.length === 0
            ? null
            : round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
        p50: sorted.length === 0 ? null : round(percentile(0.5)),
        p95: sorted.length === 0 ? null : round(percentile(0.95)),
        max: sorted.length === 0 ? null : round(sorted.at(-1))
      }
    }
    const recordLongTasks = (entries) => {
      for (const entry of entries) {
        longTaskEntries.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name
        })
        if (longTaskEntries.length > maxSamples) {
          longTaskEntries.shift()
        }
      }
    }
    try {
      longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') === true
      if (longTaskSupported) {
        observer = new PerformanceObserver((list) => recordLongTasks(list.getEntries()))
        observer.observe({ type: 'longtask', buffered: true })
      }
    } catch {
      observer = null
      longTaskSupported = false
    }
    const scheduleTimer = () => {
      const expectedAt = performance.now() + timerIntervalMs
      timerId = setTimeout(() => {
        driftCount += 1
        driftSamples.push(Math.max(0, performance.now() - expectedAt))
        if (driftSamples.length > maxSamples) {
          driftSamples.shift()
        }
        scheduleTimer()
      }, timerIntervalMs)
    }
    const snapshot = (reset) => {
      if (observer) {
        recordLongTasks(observer.takeRecords())
      }
      const capturedAt = performance.now()
      const phaseLongTasks = longTaskEntries.filter((entry) => entry.startTime >= phaseStartedAt)
      const durations = phaseLongTasks.map((entry) => entry.duration)
      const result = {
        startedAt: phaseStartedAtIso,
        capturedAt: new Date().toISOString(),
        durationMs: round(capturedAt - phaseStartedAt),
        timerIntervalMs,
        timerDriftMs: summarize(driftSamples, driftCount),
        longTasks: {
          supported: longTaskSupported,
          ...summarize(durations),
          totalDurationMs: round(durations.reduce((sum, value) => sum + value, 0)),
          entries: phaseLongTasks.slice(-maxEntries).map((entry) => ({
            startMs: round(entry.startTime - phaseStartedAt),
            durationMs: round(entry.duration),
            name: entry.name
          })),
          entriesTruncated: Math.max(0, phaseLongTasks.length - maxEntries)
        }
      }
      if (reset) {
        phaseStartedAt = capturedAt
        phaseStartedAtIso = new Date().toISOString()
        driftCount = 0
        driftSamples = []
        longTaskEntries = []
      }
      return result
    }
    scheduleTimer()
    window.__orcaIdleCpuTimingProbe = {
      snapshot: () => snapshot(true),
      stop: () => {
        if (timerId !== null) {
          clearTimeout(timerId)
        }
        const result = snapshot(false)
        observer?.disconnect()
        return result
      }
    }
  }, RENDERER_TIMER_INTERVAL_MS)
}

export async function snapshotRendererTimingProbe(page) {
  return page.evaluate(() => window.__orcaIdleCpuTimingProbe?.snapshot() ?? null)
}

export async function stopRendererTimingProbe(page) {
  return page.evaluate(() => window.__orcaIdleCpuTimingProbe?.stop() ?? null)
}

export async function runZustandPublications(page, count, intervalMs) {
  return page.evaluate(
    ({ count, intervalMs }) =>
      new Promise((resolve, reject) => {
        const store = window.__store
        if (!store) {
          reject(new Error('window.__store is not available'))
          return
        }
        const maxSamples = 5_000
        const startedAt = performance.now()
        const startedAtIso = new Date().toISOString()
        const schedulingDriftMs = []
        let completed = 0
        const finish = () => {
          const sorted = [...schedulingDriftMs].sort((left, right) => left - right)
          const percentile = (fraction) =>
            sorted.length === 0
              ? null
              : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
          const round = (value) => Math.round(value * 100) / 100
          resolve({
            requested: count,
            completed,
            intervalMs,
            startedAt: startedAtIso,
            completedAt: new Date().toISOString(),
            durationMs: round(performance.now() - startedAt),
            schedulingDriftMs: {
              retainedCount: sorted.length,
              p50: sorted.length === 0 ? null : round(percentile(0.5)),
              p95: sorted.length === 0 ? null : round(percentile(0.95)),
              max: sorted.length === 0 ? null : round(sorted.at(-1))
            }
          })
        }
        const publish = () => {
          const publishedAt = performance.now()
          const scheduledAt = startedAt + completed * intervalMs
          schedulingDriftMs.push(Math.max(0, publishedAt - scheduledAt))
          if (schedulingDriftMs.length > maxSamples) {
            schedulingDriftMs.shift()
          }
          try {
            // Why: an empty partial notifies every subscriber without changing domain state.
            store.setState({})
          } catch (error) {
            reject(error)
            return
          }
          completed += 1
          if (completed >= count) {
            finish()
            return
          }
          const nextAt = startedAt + completed * intervalMs
          setTimeout(publish, Math.max(0, nextAt - performance.now()))
        }
        if (count === 0) {
          finish()
        } else {
          setTimeout(publish, 0)
        }
      }),
    { count, intervalMs }
  )
}
