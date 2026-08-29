import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS,
  TerminalViewportResubscribeBudget,
  readTerminalViewportDims,
  resolveTerminalViewportResubscribe,
  runTerminalViewportFitPass,
  shouldResubscribeAfterViewportMeasure,
  type TerminalViewportFitPassArgs
} from './mobile-terminal-viewport-resubscribe'

const PHONE = { cols: 40, rows: 50 }

describe('readTerminalViewportDims', () => {
  it('accepts only usable numeric host dimensions', () => {
    expect(readTerminalViewportDims({ cols: 40, rows: 50 })).toEqual({
      hostCols: 40,
      hostRows: 50
    })
    expect(readTerminalViewportDims({ cols: Number.NaN, rows: 0 })).toEqual({
      hostCols: null,
      hostRows: null
    })
  })
})

describe('resolveTerminalViewportResubscribe', () => {
  it('resubscribes immediately on the first pass when the viewport is unmeasured', () => {
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: 80,
        hostRows: 24,
        viewportMeasured: false,
        viewport: null,
        attempts: 0
      })
    ).toEqual({ kind: 'resubscribe', delayMs: 0 })
  })

  it('caps even the unmeasured pass once the budget is spent', () => {
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: 80,
        hostRows: 24,
        viewportMeasured: false,
        viewport: null,
        attempts: MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS
      })
    ).toEqual({ kind: 'exhausted' })
  })

  it('holds on absent host dims instead of resubscribing (STA-3337 regression)', () => {
    for (const [hostCols, hostRows] of [
      [null, null],
      [80, null],
      [null, 24]
    ] as const) {
      expect(
        resolveTerminalViewportResubscribe({
          hostCols,
          hostRows,
          viewportMeasured: true,
          viewport: PHONE,
          attempts: 0
        })
      ).toEqual({ kind: 'hold' })
    }
  })

  it('keeps holding on absent dims across repeated frames without spending budget', () => {
    for (let frame = 0; frame < 50; frame += 1) {
      expect(
        resolveTerminalViewportResubscribe({
          hostCols: null,
          hostRows: null,
          viewportMeasured: true,
          viewport: PHONE,
          attempts: 0
        }).kind
      ).toBe('hold')
    }
  })

  it('converges when host dims match the measured viewport', () => {
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        viewportMeasured: true,
        viewport: PHONE,
        attempts: 2
      })
    ).toEqual({ kind: 'converged' })
  })

  it('backs off across mismatch attempts and then exhausts', () => {
    const delays = [0, 1, 2].map((attempts) => {
      const decision = resolveTerminalViewportResubscribe({
        hostCols: 80,
        hostRows: 24,
        viewportMeasured: true,
        viewport: PHONE,
        attempts
      })
      if (decision.kind !== 'resubscribe') {
        throw new Error(`expected resubscribe at attempt ${attempts}, got ${decision.kind}`)
      }
      return decision.delayMs
    })
    expect(delays[0]).toBe(0)
    expect(delays[1]).toBeGreaterThan(0)
    expect(delays[2]).toBeGreaterThan(delays[1])
    expect(
      resolveTerminalViewportResubscribe({
        hostCols: 80,
        hostRows: 24,
        viewportMeasured: true,
        viewport: PHONE,
        attempts: MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS
      })
    ).toEqual({ kind: 'exhausted' })
  })
})

describe('shouldResubscribeAfterViewportMeasure', () => {
  it('always resubscribes when the viewport was never measured (server must learn it)', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        measured: PHONE,
        viewportWasMeasured: false
      })
    ).toBe(true)
  })

  it('skips the resubscribe when the fresh measure already matches the host', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: PHONE.cols,
        hostRows: PHONE.rows,
        measured: PHONE,
        viewportWasMeasured: true
      })
    ).toBe(false)
  })

  it('resubscribes when the host still disagrees with the fresh measure', () => {
    expect(
      shouldResubscribeAfterViewportMeasure({
        hostCols: 80,
        hostRows: 24,
        measured: PHONE,
        viewportWasMeasured: true
      })
    ).toBe(true)
  })
})

describe('TerminalViewportResubscribeBudget', () => {
  const exhaust = (budget: TerminalViewportResubscribeBudget, handle: string) => {
    for (let i = 0; i < MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS; i += 1) {
      budget.chargeAttempt(handle)
    }
  }

  it('starts at zero and counts charged attempts per handle', () => {
    const budget = new TerminalViewportResubscribeBudget()
    expect(budget.attempts('t1')).toBe(0)
    budget.chargeAttempt('t1')
    budget.chargeAttempt('t1')
    expect(budget.attempts('t1')).toBe(2)
    expect(budget.attempts('t2')).toBe(0)
  })

  it('resets attempts and re-arms the announcement on convergence', () => {
    const budget = new TerminalViewportResubscribeBudget()
    exhaust(budget, 't1')
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
    budget.markConverged('t1')
    expect(budget.attempts('t1')).toBe(0)
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
  })

  it('announces exhaustion exactly once', () => {
    const budget = new TerminalViewportResubscribeBudget()
    exhaust(budget, 't1')
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(false)
  })

  it('does not refill an exhausted handle that stayed listed', () => {
    const budget = new TerminalViewportResubscribeBudget()
    exhaust(budget, 't1')
    for (let refresh = 0; refresh < 5; refresh += 1) {
      budget.notifyListedHandles(new Set(['t1']))
    }
    expect(budget.attempts('t1')).toBe(MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS)
  })

  it('refills only after the exhausted handle went absent and came back', () => {
    const budget = new TerminalViewportResubscribeBudget()
    exhaust(budget, 't1')
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
    budget.notifyListedHandles(new Set())
    // Still exhausted while absent — the refill lands on the return.
    expect(budget.attempts('t1')).toBe(MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS)
    budget.notifyListedHandles(new Set(['t1']))
    expect(budget.attempts('t1')).toBe(0)
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
  })

  it('leaves below-cap handles untouched by list refreshes', () => {
    const budget = new TerminalViewportResubscribeBudget()
    budget.chargeAttempt('t1')
    budget.notifyListedHandles(new Set())
    budget.notifyListedHandles(new Set(['t1']))
    expect(budget.attempts('t1')).toBe(1)
  })

  it('forget clears one handle, clear clears everything', () => {
    const budget = new TerminalViewportResubscribeBudget()
    exhaust(budget, 't1')
    exhaust(budget, 't2')
    budget.forget('t1')
    expect(budget.attempts('t1')).toBe(0)
    expect(budget.attempts('t2')).toBe(MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS)
    budget.clear()
    expect(budget.attempts('t2')).toBe(0)
  })
})

describe('runTerminalViewportFitPass', () => {
  const HANDLE = 't1'

  function makeHarness(overrides: {
    hostCols?: number | null
    hostRows?: number | null
    viewportMeasured?: boolean
    viewport?: { cols: number; rows: number } | null
    measured?: { cols: number; rows: number } | null
    budget?: TerminalViewportResubscribeBudget
  }) {
    const budget = overrides.budget ?? new TerminalViewportResubscribeBudget()
    const diagnostics = {
      streamResubscribing: vi.fn(),
      streamResubscribeHeld: vi.fn(),
      streamResubscribeExhausted: vi.fn()
    }
    const terminalUnsubsRef = { current: new Map<string, () => void>([[HANDLE, () => {}]]) }
    const scheduled: { fn: () => void; ms: number }[] = []
    const webView = {
      awaitReady: () => Promise.resolve(),
      measureFitDimensions: () => Promise.resolve(overrides.measured ?? PHONE)
    }
    const unsubscribeTerminal = vi.fn((handle: string) => {
      terminalUnsubsRef.current.delete(handle)
    })
    // Mimic the real subscribe path: arming registers an unsubscribe handle.
    const subscribeToTerminal = vi.fn((handle: string) => {
      terminalUnsubsRef.current.set(handle, () => {})
    })
    const showToast = vi.fn()
    const args: TerminalViewportFitPassArgs = {
      handle: HANDLE,
      seq: 1,
      hostCols: overrides.hostCols ?? null,
      hostRows: overrides.hostRows ?? null,
      budget,
      diagnostics,
      viewportRef: { current: overrides.viewport ?? null },
      viewportMeasuredRef: { current: overrides.viewportMeasured ?? false },
      subscribeSeqRef: { current: new Map([[HANDLE, 1]]) },
      initializedHandlesRef: { current: new Set([HANDLE]) },
      terminalUnsubsRef,
      terminalFrameHeightRef: { current: 0 },
      getTerminalRef: () => webView,
      unsubscribeTerminal,
      subscribeToTerminal,
      scheduleDelayedAction: (fn, ms) => scheduled.push({ fn, ms }),
      showToast
    }
    return {
      args,
      budget,
      diagnostics,
      scheduled,
      subscribeToTerminal,
      unsubscribeTerminal,
      showToast
    }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('holds without any teardown when host dims are absent (STA-3337 regression)', async () => {
    const h = makeHarness({ viewportMeasured: true, viewport: PHONE })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(h.subscribeToTerminal).not.toHaveBeenCalled()
    expect(h.diagnostics.streamResubscribeHeld).toHaveBeenCalledTimes(1)
  })

  it('measures and resubscribes immediately on the first pass, charging one attempt', async () => {
    const h = makeHarness({ hostCols: 80, hostRows: 24 })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.unsubscribeTerminal).toHaveBeenCalledTimes(1)
    expect(h.subscribeToTerminal).toHaveBeenCalledTimes(1)
    expect(h.args.viewportRef.current).toEqual(PHONE)
    expect(h.args.viewportMeasuredRef.current).toBe(true)
    expect(h.budget.attempts(HANDLE)).toBe(1)
  })

  it('treats an equal fresh measure as convergence instead of resubscribing', async () => {
    const budget = new TerminalViewportResubscribeBudget()
    budget.chargeAttempt(HANDLE)
    // Stale cached viewport disagrees with the host, but the fresh measure matches it.
    const h = makeHarness({
      hostCols: PHONE.cols,
      hostRows: PHONE.rows,
      viewportMeasured: true,
      viewport: { cols: 30, rows: 20 },
      measured: PHONE,
      budget
    })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.subscribeToTerminal).not.toHaveBeenCalled()
    expect(h.budget.attempts(HANDLE)).toBe(0)
  })

  it('defers later attempts through the backoff scheduler while keeping the stream up', async () => {
    const budget = new TerminalViewportResubscribeBudget()
    budget.chargeAttempt(HANDLE)
    const h = makeHarness({
      hostCols: 80,
      hostRows: 24,
      viewportMeasured: true,
      viewport: PHONE,
      budget
    })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.scheduled).toHaveLength(1)
    expect(h.scheduled[0].ms).toBeGreaterThan(0)
    // The stream must still be up until the deferred retry fires.
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled()
    h.scheduled[0].fn()
    expect(h.unsubscribeTerminal).toHaveBeenCalledTimes(1)
    expect(h.subscribeToTerminal).toHaveBeenCalledTimes(1)
    expect(h.budget.attempts(HANDLE)).toBe(2)
  })

  it('drops a deferred retry whose subscribe generation went stale', async () => {
    const budget = new TerminalViewportResubscribeBudget()
    budget.chargeAttempt(HANDLE)
    const h = makeHarness({
      hostCols: 80,
      hostRows: 24,
      viewportMeasured: true,
      viewport: PHONE,
      budget
    })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.scheduled).toHaveLength(1)
    h.args.subscribeSeqRef.current.set(HANDLE, 2)
    h.scheduled[0].fn()
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(h.budget.attempts(HANDLE)).toBe(1)
  })

  it('drops a deferred retry after the live stream converges', async () => {
    const budget = new TerminalViewportResubscribeBudget()
    budget.chargeAttempt(HANDLE)
    const h = makeHarness({
      hostCols: 80,
      hostRows: 24,
      viewportMeasured: true,
      viewport: PHONE,
      budget
    })
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.scheduled).toHaveLength(1)
    expect(h.budget.observeResize(HANDLE, PHONE, PHONE)).toEqual([PHONE.cols, PHONE.rows])
    h.scheduled[0].fn()
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(h.subscribeToTerminal).not.toHaveBeenCalled()
    expect(h.budget.attempts(HANDLE)).toBe(0)
  })

  it('announces exhaustion once and stops touching the stream', async () => {
    const budget = new TerminalViewportResubscribeBudget()
    for (let i = 0; i < MAX_TERMINAL_VIEWPORT_RESUBSCRIBE_ATTEMPTS; i += 1) {
      budget.chargeAttempt(HANDLE)
    }
    const h = makeHarness({
      hostCols: 80,
      hostRows: 24,
      viewportMeasured: true,
      viewport: PHONE,
      budget
    })
    runTerminalViewportFitPass(h.args)
    runTerminalViewportFitPass(h.args)
    await settle()
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(h.subscribeToTerminal).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledTimes(1)
    expect(h.diagnostics.streamResubscribeExhausted).toHaveBeenCalledTimes(2)
  })
})

describe('STA-3337 stream shapes', () => {
  it('empty scrollback with absent dims settles after a single register pass', () => {
    const budget = new TerminalViewportResubscribeBudget()
    // Pass 1: no viewport yet — measure and resubscribe so the server learns it.
    const first = resolveTerminalViewportResubscribe({
      hostCols: null,
      hostRows: null,
      viewportMeasured: false,
      viewport: null,
      attempts: budget.attempts('t1')
    })
    expect(first).toEqual({ kind: 'resubscribe', delayMs: 0 })
    budget.chargeAttempt('t1')
    // Pass 2+: host still reports no dims — the stream must be left alone.
    for (let frame = 0; frame < 10; frame += 1) {
      expect(
        resolveTerminalViewportResubscribe({
          hostCols: null,
          hostRows: null,
          viewportMeasured: true,
          viewport: PHONE,
          attempts: budget.attempts('t1')
        }).kind
      ).toBe('hold')
    }
    expect(budget.attempts('t1')).toBe(1)
  })

  it('non-converging numeric dims degrade after the bounded backoff run', () => {
    const budget = new TerminalViewportResubscribeBudget()
    const kinds: string[] = []
    for (let frame = 0; frame < 6; frame += 1) {
      const decision = resolveTerminalViewportResubscribe({
        hostCols: 80,
        hostRows: 24,
        viewportMeasured: frame > 0,
        viewport: frame > 0 ? PHONE : null,
        attempts: budget.attempts('t1')
      })
      kinds.push(decision.kind)
      if (decision.kind === 'resubscribe') {
        budget.chargeAttempt('t1')
      }
    }
    expect(kinds).toEqual([
      'resubscribe',
      'resubscribe',
      'resubscribe',
      'exhausted',
      'exhausted',
      'exhausted'
    ])
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(true)
    expect(budget.shouldAnnounceExhaustion('t1')).toBe(false)
  })
})
