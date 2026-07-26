import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { TERMINAL_SCROLL_COORDINATOR_JS } from './terminal-scroll-coordinator-injected'
import type {
  TerminalScrollAdapter,
  TerminalScrollEvent,
  TerminalScrollMetrics,
  TerminalScrollState
} from './terminal-scroll-coordinator'

type TerminalScrollCoordinator = {
  dispatch: (event: TerminalScrollEvent) => boolean
  getState: () => TerminalScrollState
}

const injectedContext: {
  createTerminalScrollCoordinator?: (adapter: TerminalScrollAdapter) => TerminalScrollCoordinator
} = {}
new Script(
  `${TERMINAL_SCROLL_COORDINATOR_JS}\nthis.createTerminalScrollCoordinator = createTerminalScrollCoordinator;`
).runInNewContext(injectedContext)
const createTerminalScrollCoordinator = injectedContext.createTerminalScrollCoordinator!

function makeHarness(initial: Partial<TerminalScrollMetrics> = {}) {
  const metrics: TerminalScrollMetrics = {
    baseY: 0,
    viewportY: 0,
    bufferMode: 'normal',
    ...initial
  }
  const calls: string[] = []
  const adapter: TerminalScrollAdapter = {
    readMetrics: () => ({ ...metrics }),
    scrollLines(lines) {
      metrics.viewportY = Math.max(0, Math.min(metrics.baseY, metrics.viewportY + lines))
      calls.push(`lines:${lines}`)
    },
    scrollToBottom() {
      metrics.viewportY = metrics.baseY
      calls.push('bottom')
    },
    scrollToLine(line) {
      metrics.viewportY = Math.max(0, Math.min(metrics.baseY, line))
      calls.push(`line:${line}`)
    },
    changeViewport(change) {
      calls.push(`viewport:${change.reason}`)
    },
    routeTerminalInput(lines) {
      calls.push(`input:${lines}`)
    },
    shouldRouteToTerminalInput: () => metrics.bufferMode === 'alternate',
    revealIndicator() {
      calls.push('indicator')
    }
  }
  return { adapter, calls, metrics }
}

describe('terminal scroll coordinator', () => {
  it('places a newly replayed session at the live bottom', () => {
    const { adapter, calls, metrics } = makeHarness()
    const coordinator = createTerminalScrollCoordinator(adapter)

    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    metrics.baseY = 200
    metrics.viewportY = 0
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })

    expect(metrics.viewportY).toBe(200)
    expect(calls).toEqual(['bottom'])
    expect(coordinator.getState().intent).toBe('following-output')
  })

  it('preserves the reader distance from bottom across replay and viewport changes', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 200, viewportY: 150 })
    const coordinator = createTerminalScrollCoordinator(adapter)

    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: true })
    metrics.baseY = 260
    metrics.viewportY = 260
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    expect(metrics.viewportY).toBe(210)

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 60, rows: 30, reason: 'reflow' }
    })
    metrics.baseY = 280
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(metrics.viewportY).toBe(230)
    expect(calls).toEqual(['line:210', 'viewport:reflow', 'line:230'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'reading-history',
      distanceFromBottom: 50
    })
  })

  it('restores the live bottom when reflow leaves the viewport behind', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    metrics.baseY = 110
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(metrics.viewportY).toBe(110)
    expect(calls).toEqual(['viewport:reflow', 'bottom'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'following-output',
      distanceFromBottom: 0
    })
  })

  it('does not issue a second bottom snap when reflow stays pinned', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    metrics.baseY = 110
    metrics.viewportY = 110
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(calls).toEqual(['viewport:reflow'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'following-output',
      distanceFromBottom: 0
    })
  })

  it('defers output following until a viewport transition commits', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    coordinator.dispatch({ type: 'output-started', generation: 1 })
    metrics.baseY = 110
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(metrics.viewportY).toBe(110)
    expect(calls).toEqual(['viewport:reflow', 'bottom'])
  })

  it('lets an active drag replace a stale viewport-transition anchor', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: -20 })
    metrics.baseY = 110
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(metrics.viewportY).toBe(90)
    expect(calls).toEqual(['viewport:reflow', 'lines:-20', 'indicator', 'line:90'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'reading-history',
      distanceFromBottom: 20
    })
  })

  it('coalesces multiple output commits during one viewport transition', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    metrics.baseY = 110
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    metrics.baseY = 120
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })

    expect(metrics.viewportY).toBe(120)
    expect(calls).toEqual(['viewport:reflow', 'bottom'])
  })

  it('follows output that commits just after a viewport transition', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({
      type: 'viewport-change',
      generation: 1,
      change: { cols: 80, rows: 14, reason: 'reflow' }
    })
    coordinator.dispatch({ type: 'viewport-committed', generation: 1 })
    metrics.baseY = 110
    coordinator.dispatch({ type: 'output-committed', generation: 1 })

    expect(metrics.viewportY).toBe(110)
    expect(calls).toEqual(['viewport:reflow', 'bottom'])
  })

  it('keeps repeated keyboard-driven reflows free of scroll commands', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    for (const rows of [14, 24, 14, 24]) {
      coordinator.dispatch({
        type: 'viewport-change',
        generation: 1,
        change: { cols: 80, rows, reason: 'reflow' }
      })
      metrics.baseY += rows === 14 ? 10 : -10
      metrics.viewportY = metrics.baseY
      coordinator.dispatch({ type: 'viewport-committed', generation: 1 })
    }

    expect(calls).toEqual([
      'viewport:reflow',
      'viewport:reflow',
      'viewport:reflow',
      'viewport:reflow'
    ])
    expect(coordinator.getState().intent).toBe('following-output')
  })

  it('never lets output steal the viewport after the user starts reading history', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: -10 })
    metrics.baseY = 101
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    metrics.baseY = 102
    coordinator.dispatch({ type: 'output-committed', generation: 1 })

    expect(metrics.viewportY).toBe(90)
    expect(calls).toEqual(['lines:-10', 'indicator'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'reading-history',
      distanceFromBottom: 12
    })
  })

  it('restores the latest reader viewport if xterm moves during an async write', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 70 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: true })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({ type: 'output-started', generation: 1 })
    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: -5 })
    metrics.baseY = 101
    metrics.viewportY = 101
    coordinator.dispatch({ type: 'output-committed', generation: 1 })

    expect(metrics.viewportY).toBe(65)
    expect(calls).toEqual(['lines:-5', 'indicator', 'line:65'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'reading-history',
      distanceFromBottom: 36
    })
  })

  it('does not restore an old output anchor after an explicit jump to bottom', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 70 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: true })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({ type: 'output-started', generation: 1 })
    coordinator.dispatch({ type: 'jump-to-bottom', generation: 1 })
    metrics.baseY = 101
    coordinator.dispatch({ type: 'output-committed', generation: 1 })

    expect(metrics.viewportY).toBe(101)
    expect(calls).toEqual(['bottom', 'bottom'])
    expect(coordinator.getState().intent).toBe('following-output')
  })

  it('resumes output following after the user reaches the bottom', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 80 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: true })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: 20 })
    metrics.baseY = 101
    coordinator.dispatch({ type: 'output-committed', generation: 1 })

    expect(metrics.viewportY).toBe(101)
    expect(calls).toEqual(['lines:20', 'indicator', 'bottom'])
    expect(coordinator.getState().intent).toBe('following-output')
  })

  it('drops stale callbacks from replaced terminal generations', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'begin-generation', generation: 2, preserveScroll: false })
    calls.length = 0

    metrics.baseY = 101
    coordinator.dispatch({ type: 'output-committed', generation: 1 })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })

    expect(calls).toEqual([])
    expect(metrics.viewportY).toBe(100)
  })

  it('preserves explicit output following across a snapshot replay with transient metrics', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    metrics.baseY = 180
    metrics.viewportY = 100
    coordinator.dispatch({ type: 'begin-generation', generation: 2, preserveScroll: true })
    metrics.baseY = 220
    metrics.viewportY = 220
    coordinator.dispatch({ type: 'replay-committed', generation: 2 })

    expect(metrics.viewportY).toBe(220)
    expect(calls).toEqual(['bottom'])
    expect(coordinator.getState().intent).toBe('following-output')
  })

  it('preserves explicit history reading across later snapshot replays', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: -20 })
    calls.length = 0

    metrics.baseY = 180
    metrics.viewportY = 160
    coordinator.dispatch({ type: 'begin-generation', generation: 2, preserveScroll: true })
    metrics.baseY = 220
    metrics.viewportY = 220
    coordinator.dispatch({ type: 'replay-committed', generation: 2 })

    expect(metrics.viewportY).toBe(200)
    expect(calls).toEqual(['line:200'])
    expect(coordinator.getState()).toMatchObject({
      intent: 'reading-history',
      distanceFromBottom: 20
    })
  })

  it('stays at the live bottom through sustained output', () => {
    const { adapter, calls, metrics } = makeHarness({ baseY: 100, viewportY: 100 })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })
    coordinator.dispatch({ type: 'replay-committed', generation: 1 })
    calls.length = 0

    for (let index = 0; index < 100; index += 1) {
      coordinator.dispatch({ type: 'output-started', generation: 1 })
      metrics.baseY += 3
      metrics.viewportY = Math.max(0, metrics.baseY - 40)
      coordinator.dispatch({ type: 'output-committed', generation: 1 })
      expect(metrics.viewportY).toBe(metrics.baseY)
    }

    expect(calls).toHaveLength(100)
    expect(new Set(calls)).toEqual(new Set(['bottom']))
  })

  it('routes alternate-screen scrolling as terminal input without changing scroll intent', () => {
    const { adapter, calls } = makeHarness({
      baseY: 0,
      viewportY: 0,
      bufferMode: 'alternate'
    })
    const coordinator = createTerminalScrollCoordinator(adapter)
    coordinator.dispatch({ type: 'begin-generation', generation: 1, preserveScroll: false })

    coordinator.dispatch({ type: 'user-scroll-lines', generation: 1, lines: -3 })

    expect(calls).toEqual(['input:-3'])
    expect(coordinator.getState().intent).toBe('following-output')
  })
})
