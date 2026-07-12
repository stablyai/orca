import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  isTerminalUpdateViewportApplied,
  isTerminalUpdateViewportUpdated,
  isTerminalViewportRefitTargetCurrent
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

  it('is wired into the session screen', () => {
    expect(sessionSource).toContain('useTerminalViewportRefit({')
    expect(sessionSource).toContain('tabStripVisible: terminals.length > 1')
    expect(sessionSource).toContain('textScale: terminalTextScale')
    expect(sessionSource).toContain('connState,')
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
  })
})
