import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  isTerminalUpdateViewportApplied,
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

  it('is wired into the session screen', () => {
    expect(sessionSource).toContain('useTerminalViewportRefit({')
    expect(sessionSource).toContain('tabStripVisible: terminals.length > 1')
  })

  it('prefers the in-place updateViewport RPC over resubscribe', () => {
    const rpcIndex = hookSource.indexOf("sendRequest('terminal.updateViewport'")
    const resubscribeIndex = hookSource.indexOf('subscribeToTerminal(handle)')
    expect(rpcIndex).toBeGreaterThanOrEqual(0)
    expect(resubscribeIndex).toBeGreaterThan(rpcIndex)
  })

  it('only treats updateViewport as applied when the runtime updated the subscriber', () => {
    const okUpdated = {
      id: '1',
      ok: true,
      result: { updated: true },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    const okNotUpdated = {
      id: '2',
      ok: true,
      result: { updated: false },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    const failed = {
      id: '3',
      ok: false,
      error: { code: 'missing', message: 'missing subscriber' },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse

    expect(isTerminalUpdateViewportApplied(okUpdated)).toBe(true)
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
