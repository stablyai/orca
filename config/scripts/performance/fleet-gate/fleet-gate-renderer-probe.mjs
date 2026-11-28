// Renderer counters over CDP: store publications, subscriber wakeups, no-op publications, long tasks, heap.

import { locateStoreNotifications } from './fleet-gate-store-notify.mjs'

function installPageCounters() {
  if (globalThis.__fleetGateRenderer) {
    return
  }
  const state = { pubs: 0, wakeups: 0, noop: 0, longN: 0, longMs: 0, longMax: 0 }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.longN += 1
      state.longMs += entry.duration
      state.longMax = Math.max(state.longMax, entry.duration)
    }
  })
  observer.observe({ type: 'longtask', buffered: false })
  globalThis.__fleetGateRenderer = {
    // Called from the breakpoint condition; returning false keeps the breakpoint from pausing.
    pub(listenerCount, next, previous) {
      state.pubs += 1
      state.wakeups += listenerCount
      if (next && previous && typeof next === 'object' && typeof previous === 'object') {
        let changed = false
        for (const key in next) {
          if (!Object.is(next[key], previous[key])) {
            changed = true
            break
          }
        }
        if (!changed) {
          state.noop += 1
        }
      }
      return false
    },
    reset() {
      for (const key of Object.keys(state)) {
        state[key] = 0
      }
    },
    snapshot() {
      return { ...state, longMs: Math.round(state.longMs), longMax: Math.round(state.longMax) }
    }
  }
}

function offsetToLocation(source, offset) {
  let line = 0
  let lineStart = 0
  for (let index = source.indexOf('\n'); index !== -1 && index < offset;) {
    line += 1
    lineStart = index + 1
    index = source.indexOf('\n', lineStart)
  }
  return { lineNumber: line, columnNumber: offset - lineStart }
}

export async function installRendererProbe(page) {
  await page.evaluate(installPageCounters)
  const cdp = await page.context().newCDPSession(page)
  const scripts = []
  const onScriptParsed = (event) => scripts.push(event)
  cdp.on('Debugger.scriptParsed', onScriptParsed)
  const debuggerEnabled = await cdp.send('Debugger.enable').then(
    () => true,
    () => false
  )
  if (debuggerEnabled) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  cdp.off('Debugger.scriptParsed', onScriptParsed)
  let breakpoints = 0
  let attachmentFailed = !debuggerEnabled
  for (const script of scripts) {
    // A split renderer chunk can contain just the store factory and its React bindings.
    if (!script.url) {
      continue
    }
    const scriptContents = await cdp
      .send('Debugger.getScriptSource', { scriptId: script.scriptId })
      .catch(() => null)
    if (!scriptContents) {
      attachmentFailed = true
      continue
    }
    const { scriptSource } = scriptContents
    if (!scriptSource) {
      continue
    }
    for (const { start, end, listeners, next, previous } of locateStoreNotifications(
      scriptSource
    )) {
      const possible = await cdp
        .send('Debugger.getPossibleBreakpoints', {
          start: { scriptId: script.scriptId, ...offsetToLocation(scriptSource, start) },
          end: { scriptId: script.scriptId, ...offsetToLocation(scriptSource, end) },
          restrictToFunction: true
        })
        .catch(() => null)
      const location = possible?.locations[0]
      if (!location) {
        attachmentFailed = true
        continue
      }
      const breakpoint = await cdp
        .send('Debugger.setBreakpoint', {
          location,
          condition: `globalThis.__fleetGateRenderer ? globalThis.__fleetGateRenderer.pub(${listeners}.size, ${next}, ${previous}) : false`
        })
        .catch(() => null)
      if (breakpoint) {
        breakpoints += 1
      } else {
        attachmentFailed = true
      }
    }
  }
  const storeMeasured = breakpoints > 0 && !attachmentFailed
  if (!storeMeasured && debuggerEnabled) {
    await cdp.send('Debugger.disable').catch(() => {})
  }
  return {
    breakpoints,
    storeMeasured,
    async reset() {
      await page.evaluate(() => globalThis.__fleetGateRenderer.reset())
    },
    async snapshot() {
      const counters = await page.evaluate(() => globalThis.__fleetGateRenderer.snapshot())
      const { usedSize } = await cdp.send('Runtime.getHeapUsage')
      return { ...counters, heapUsedMb: Math.round(usedSize / 1048576) }
    }
  }
}
