import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  isTerminalUpdateViewportApplied,
  isTerminalUpdateViewportUpdated,
  isTerminalViewportRefitTargetCurrent,
  reduceTerminalFrameHeightRefit,
  resolveTerminalUpdateViewportCapability,
  type TerminalFrameHeightRefitEvent,
  type TerminalFrameHeightRefitState,
  type TerminalUpdateViewportCapability
} from './terminal-viewport-refit-state'

const hookSource = readFileSync(new URL('./terminal-viewport-refit.ts', import.meta.url), 'utf8')
const sessionSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('terminal viewport refit', () => {
  it('refits when the window dimensions change (fold/unfold, rotation)', () => {
    // Why: a PTY fitted on the folded cover screen must be re-measured when
    // the window grows, or the terminal renders in a fraction of the display.
    expect(hookSource).toContain('useWindowDimensions()')
    const start = hookSource.indexOf('const { width: windowWidth, height: windowHeight }')
    expect(start).toBeGreaterThanOrEqual(0)
    const resizeEffect = hookSource.slice(start)
    expect(resizeEffect).toContain('viewportMeasuredRef.current = false')
    expect(resizeEffect).toContain('scheduleViewportRefit()')
    expect(resizeEffect).toContain(
      '[windowWidth, windowHeight, viewportMeasuredRef, scheduleViewportRefit]'
    )
  })

  it('still refits when the tab strip toggles visibility', () => {
    const start = hookSource.indexOf('const prevTabStripVisibleRef')
    expect(start).toBeGreaterThanOrEqual(0)
    const tabEffect = hookSource.slice(start, hookSource.indexOf('useWindowDimensions()'))
    expect(tabEffect).toContain('viewportMeasuredRef.current = false')
    expect(tabEffect).toContain('scheduleViewportRefit()')
  })

  it('refits the PTY when terminal text scale changes', () => {
    // Why: mobile text size must change the real PTY grid, not just scale pixels
    // in the WebView, or wrapped CLI output diverges from what the shell sees.
    const start = hookSource.indexOf('const prevTextScaleRef = useRef(textScale)')
    expect(start).toBeGreaterThanOrEqual(0)
    const textScaleEffect = hookSource.slice(start, start + 600)
    expect(textScaleEffect).toContain('prevTextScaleRef.current === textScale')
    expect(textScaleEffect).toContain('viewportMeasuredRef.current = false')
    expect(textScaleEffect).toContain('scheduleViewportRefit()')
    expect(textScaleEffect).toContain('[textScale, viewportMeasuredRef, scheduleViewportRefit]')
  })

  it('coalesces keyboard-visible frame-height churn into one refit after close', () => {
    let state: TerminalFrameHeightRefitState = {
      frameHeight: 600,
      keyboardVisible: false,
      pending: false
    }
    let refitCount = 0
    const dispatch = (event: TerminalFrameHeightRefitEvent) => {
      const transition = reduceTerminalFrameHeightRefit(state, event)
      state = transition.state
      refitCount += Number(transition.shouldRefit)
    }

    dispatch({ type: 'keyboard-visibility', visible: true })
    dispatch({ type: 'frame-height', height: 540 })
    dispatch({ type: 'frame-height', height: 520 })
    dispatch({ type: 'frame-height', height: 520 })
    expect(refitCount).toBe(0)
    expect(state.pending).toBe(true)

    dispatch({ type: 'keyboard-visibility', visible: false })
    dispatch({ type: 'keyboard-visibility', visible: false })
    dispatch({ type: 'frame-height', height: 520 })
    expect(refitCount).toBe(1)
    expect(state.pending).toBe(false)

    dispatch({ type: 'frame-height', height: 500 })
    expect(refitCount).toBe(2)
  })

  it('routes imperative height notifications through the keyboard-aware reducer', () => {
    const start = hookSource.indexOf('const notifyFrameHeightRefitEvent = useCallback(')
    expect(start).toBeGreaterThanOrEqual(0)
    const notifier = hookSource.slice(start, start + 1_300)
    expect(notifier).toContain('reduceTerminalFrameHeightRefit(')
    expect(notifier).toContain("{ type: 'frame-height', height }")
    expect(notifier).toContain("{ type: 'keyboard-visibility', visible }")
    expect(notifier).toContain('viewportMeasuredRef.current = false')
    expect(notifier).toContain('scheduleViewportRefit({ heightOriginated: true })')
  })

  it('re-defers a height refit if the keyboard reopens before the debounce fires', () => {
    // Settle while the keyboard is up -> deferred (pending), no refit.
    let r = reduceTerminalFrameHeightRefit(
      { frameHeight: 600, keyboardVisible: true, pending: false },
      { type: 'frame-height', height: 520 }
    )
    expect(r.shouldRefit).toBe(false)
    expect(r.state.pending).toBe(true)

    // Keyboard closes -> refit scheduled (the hook arms a 150ms timer here).
    r = reduceTerminalFrameHeightRefit(r.state, { type: 'keyboard-visibility', visible: false })
    expect(r.shouldRefit).toBe(true)

    // Keyboard reopens inside the debounce window, then the timer fires:
    // the committed refit must NOT reflow while typing, and stays owed.
    r = reduceTerminalFrameHeightRefit(r.state, { type: 'keyboard-visibility', visible: true })
    const committed = reduceTerminalFrameHeightRefit(r.state, { type: 'refit-committed' })
    expect(committed.shouldRefit).toBe(false)
    expect(committed.state.pending).toBe(true)

    // Keyboard closes again -> rescheduled -> now the committed refit runs.
    const rescheduled = reduceTerminalFrameHeightRefit(committed.state, {
      type: 'keyboard-visibility',
      visible: false
    })
    expect(rescheduled.shouldRefit).toBe(true)
    const ran = reduceTerminalFrameHeightRefit(rescheduled.state, { type: 'refit-committed' })
    expect(ran.shouldRefit).toBe(true)
    expect(ran.state.pending).toBe(false)
  })

  it('re-checks the keyboard at fire time only for height-originated refits', () => {
    const start = hookSource.indexOf('refitTimerRef.current = setTimeout(')
    expect(start).toBeGreaterThanOrEqual(0)
    const timerBody = hookSource.slice(start, start + 900)
    // The height flag scopes the guard; forced/width refits stay unguarded.
    expect(timerBody).toContain('if (heightOriginatedRefitRef.current)')
    expect(timerBody).toContain("type: 'refit-committed'")
    expect(timerBody).toContain('if (!decision.shouldRefit)')
  })

  it('suppresses refits while native chat covers the active terminal', () => {
    // Why: native chat renders the transcript, not the grid — a refit there would
    // reflow the desktop PTY to phone dims the user never sees.
    const timerStart = hookSource.indexOf('refitTimerRef.current = setTimeout(')
    const coveredCheck = hookSource.indexOf('if (nativeChatCoveredRef.current)', timerStart)
    const measureIndex = hookSource.indexOf('measureFitDimensions', timerStart)
    expect(timerStart).toBeGreaterThanOrEqual(0)
    expect(coveredCheck).toBeGreaterThan(timerStart)
    expect(measureIndex).toBeGreaterThan(coveredCheck)
    expect(sessionSource).toContain('nativeChatCoveredRef: showNativeChatRef')
  })

  it('is wired into the session screen', () => {
    expect(sessionSource).toContain('useTerminalViewportRefit({')
    expect(sessionSource).toContain('tabStripVisible: terminals.length > 1')
    expect(sessionSource).toContain('textScale: terminalTextScale')
    expect(sessionSource).toContain('connState,')
    expect(sessionSource).toContain('notifyTerminalFrameHeight(nextHeight)')
    expect(sessionSource).toContain('notifyKeyboardVisibility(true)')
    expect(sessionSource).toContain('notifyKeyboardVisibility(false)')
  })

  it('does not rerender SessionScreen for frame-height-only layout changes', () => {
    // The imperative notifier keeps a dock-settling burst off React's render path.
    expect(sessionSource).not.toContain('setTerminalFrameHeight')
    expect(sessionSource).not.toContain('const [terminalFrameHeight,')
  })

  it('defers height-only window resizes while the keyboard is visible', () => {
    const start = hookSource.indexOf('const prevWindowDimsRef')
    const windowEffect = hookSource.slice(start, start + 1_100)
    expect(windowEffect).toContain(
      'prev.width === windowWidth && frameHeightRefitStateRef.current.keyboardVisible'
    )
  })

  it('forces a refit on iOS foreground and connection recovery', () => {
    const foregroundEffect = hookSource.slice(
      hookSource.indexOf("if (Platform.OS !== 'ios')"),
      hookSource.indexOf('const previousConnStateRef')
    )
    const reconnectEffect = hookSource.slice(
      hookSource.indexOf('const previousConnStateRef'),
      hookSource.indexOf('disposedRef.current = false')
    )

    expect(foregroundEffect).toContain("AppState.addEventListener('change'")
    expect(foregroundEffect).toContain('viewportMeasuredRef.current = false')
    expect(foregroundEffect).toContain('scheduleForcedViewportRefit()')
    expect(reconnectEffect).toContain("connState !== 'connected'")
    expect(reconnectEffect).toContain('viewportMeasuredRef.current = false')
    expect(reconnectEffect).toContain('scheduleForcedViewportRefit()')
  })

  it('bypasses the equal-dimensions guard for resume and reconnect refits', () => {
    expect(hookSource).toContain('const forceRefit = forceNextRefitRef.current')
    expect(hookSource).toContain(
      'if (!forceRefit && prev && prev.cols === dims.cols && prev.rows === dims.rows)'
    )
    const forceRead = hookSource.indexOf('const forceRefit = forceNextRefitRef.current')
    const updateViewport = hookSource.indexOf("sendRequest('terminal.updateViewport'")
    expect(forceRead).toBeGreaterThanOrEqual(0)
    expect(updateViewport).toBeGreaterThan(forceRead)
  })

  it('prefers the in-place updateViewport RPC over resubscribe', () => {
    const rpcIndex = hookSource.indexOf("sendRequest('terminal.updateViewport'")
    const cacheUpdateIndex = hookSource.indexOf('updateTerminalSubscriptionViewport(handle, dims)')
    const resubscribeIndex = hookSource.indexOf('subscribeToTerminal(handle)')
    expect(rpcIndex).toBeGreaterThanOrEqual(0)
    expect(cacheUpdateIndex).toBeGreaterThan(rpcIndex)
    expect(resubscribeIndex).toBeGreaterThan(rpcIndex)
  })

  it('falls back to legacy resubscribe when an older desktop lacks updateViewport', () => {
    const unsupported = {
      id: 'old-host',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: terminal.updateViewport' },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    expect(isTerminalUpdateViewportUpdated(unsupported)).toBe(false)
    expect(
      resolveTerminalUpdateViewportCapability({
        ...unsupported,
        error: { code: 'temporary_failure', message: 'retryable' }
      })
    ).toBe('unknown')

    let capability: TerminalUpdateViewportCapability = 'unknown'
    let probeCount = 0
    for (let refit = 0; refit < 10; refit += 1) {
      if (capability === 'unsupported') {
        continue
      }
      probeCount += 1
      capability = resolveTerminalUpdateViewportCapability(unsupported)
    }
    expect(probeCount).toBe(1)

    const responseCheckIndex = hookSource.indexOf('isTerminalUpdateViewportUpdated(response)')
    const unsubscribeIndex = hookSource.indexOf('unsubscribeTerminal(handle)', responseCheckIndex)
    const subscribeIndex = hookSource.indexOf('subscribeToTerminal(handle)', unsubscribeIndex)
    expect(responseCheckIndex).toBeGreaterThanOrEqual(0)
    expect(unsubscribeIndex).toBeGreaterThan(responseCheckIndex)
    expect(subscribeIndex).toBeGreaterThan(unsubscribeIndex)
    expect(hookSource).toContain("updateViewportCapabilityRef.current !== 'unsupported'")
    expect(hookSource).toContain("updateViewportCapabilityRef.current = 'unknown'")
  })

  it('reflows the local xterm scrollback after a successful updateViewport', () => {
    // Why: updateViewport may only record an informational mobile viewport in
    // desktop mode. Reflow local scrollback only after the server says it
    // actually applied phone-fit to the PTY.
    const appliedIndex = hookSource.indexOf('isTerminalUpdateViewportApplied(response)')
    const reflowIndex = hookSource.indexOf('ref.reflow(dims.cols, dims.rows)')
    const cacheUpdateIndex = hookSource.indexOf('updateTerminalSubscriptionViewport(handle, dims)')
    // Assert each anchor exists before ordering: a missing marker yields -1 and would
    // let the ordering comparisons pass vacuously.
    expect(appliedIndex).toBeGreaterThanOrEqual(0)
    expect(cacheUpdateIndex).toBeGreaterThanOrEqual(0)
    expect(reflowIndex).toBeGreaterThanOrEqual(0)
    expect(reflowIndex).toBeGreaterThan(appliedIndex)
    expect(reflowIndex).toBeGreaterThan(cacheUpdateIndex)
  })

  it('checks refit freshness after updateViewport resolves before side effects', () => {
    // Why: rapid dock/sidebar resizing can complete RPCs out of order; a stale
    // response must not update the viewport cache or locally reflow the old dims.
    const responseIndex = hookSource.indexOf("sendRequest('terminal.updateViewport'")
    const postRpcCurrentIndex = hookSource.indexOf('if (!isCurrentTarget())', responseIndex)
    const cacheUpdateIndex = hookSource.indexOf('updateTerminalSubscriptionViewport(handle, dims)')
    expect(postRpcCurrentIndex).toBeGreaterThan(responseIndex)
    expect(postRpcCurrentIndex).toBeLessThan(cacheUpdateIndex)
  })

  it('only treats updateViewport as applied when the runtime updated the subscriber', () => {
    const okUpdated = {
      id: '1',
      ok: true,
      result: { updated: true, applied: true },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    const okRecordedButNotApplied = {
      id: '1b',
      ok: true,
      result: { updated: true, applied: false },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    const okNotUpdated = {
      id: '2',
      ok: true,
      result: { updated: false, applied: false },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    const failed = {
      id: '3',
      ok: false,
      error: { code: 'missing', message: 'missing subscriber' },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse

    expect(isTerminalUpdateViewportUpdated(okUpdated)).toBe(true)
    expect(isTerminalUpdateViewportUpdated(okRecordedButNotApplied)).toBe(true)
    expect(isTerminalUpdateViewportUpdated(okNotUpdated)).toBe(false)
    expect(isTerminalUpdateViewportApplied(okUpdated)).toBe(true)
    expect(isTerminalUpdateViewportApplied(okRecordedButNotApplied)).toBe(false)
    expect(isTerminalUpdateViewportApplied(okNotUpdated)).toBe(false)
    expect(isTerminalUpdateViewportApplied(failed)).toBe(false)
  })

  it('rejects stale async refits when the active terminal, ref, or run changes', () => {
    const expectedRef = { resetZoom: () => {} }
    const current = {
      activeHandle: 'term-1',
      expectedHandle: 'term-1',
      currentRef: expectedRef,
      expectedRef,
      nativeChatCovered: false,
      disposed: false,
      runSeq: 2,
      currentRunSeq: 2
    }

    expect(isTerminalViewportRefitTargetCurrent(current)).toBe(true)
    expect(isTerminalViewportRefitTargetCurrent({ ...current, activeHandle: 'term-2' })).toBe(false)
    expect(
      isTerminalViewportRefitTargetCurrent({ ...current, currentRef: { resetZoom: () => {} } })
    ).toBe(false)
    expect(isTerminalViewportRefitTargetCurrent({ ...current, currentRunSeq: 3 })).toBe(false)
    expect(isTerminalViewportRefitTargetCurrent({ ...current, disposed: true })).toBe(false)
    expect(isTerminalViewportRefitTargetCurrent({ ...current, nativeChatCovered: true })).toBe(
      false
    )
  })
})
