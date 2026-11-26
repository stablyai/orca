// Renderer counters over CDP: store publications, subscriber wakeups, no-op publications, long tasks, heap.

// zustand's notify loop, minified or not: `listeners.forEach((listener) => listener(state, previousState))`.
const NOTIFY_LOOP = /([\w$]+)\.forEach\(\(?([\w$]+)\)?\s*=>\s*\2\(([\w$]+),\s*([\w$]+)\)\)/g
// Only the loop that follows zustand's merge of the next state, not any other forEach of the same shape.
const STORE_MERGE = 'Object.assign({},'

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
  cdp.on('Debugger.scriptParsed', (event) => scripts.push(event))
  await cdp.send('Debugger.enable')
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  let breakpoints = 0
  for (const script of scripts) {
    if (!script.url || script.length < 1_000) {
      continue
    }
    const { scriptSource } = await cdp.send('Debugger.getScriptSource', {
      scriptId: script.scriptId
    })
    for (const match of scriptSource.matchAll(NOTIFY_LOOP)) {
      const window = scriptSource.slice(Math.max(0, match.index - 400), match.index)
      if (!window.includes(STORE_MERGE)) {
        continue
      }
      const [, listeners, , next, previous] = match
      const start = offsetToLocation(scriptSource, match.index)
      const end = offsetToLocation(scriptSource, match.index + match[0].length)
      const { locations } = await cdp.send('Debugger.getPossibleBreakpoints', {
        start: { scriptId: script.scriptId, ...start },
        end: { scriptId: script.scriptId, ...end }
      })
      if (locations.length === 0) {
        continue
      }
      await cdp.send('Debugger.setBreakpoint', {
        location: locations[0],
        condition: `globalThis.__fleetGateRenderer ? globalThis.__fleetGateRenderer.pub(${listeners}.size, ${next}, ${previous}) : false`
      })
      breakpoints += 1
    }
  }
  return {
    breakpoints,
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
