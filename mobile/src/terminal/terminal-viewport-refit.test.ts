import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { terminalViewportUpdate } from './mobile-terminal-operations'
import {
  isTerminalViewportRefitTargetCurrent,
  reduceTerminalFrameHeightRefit,
  resolveTerminalUpdateViewportCapability,
  type TerminalFrameHeightRefitEvent,
  type TerminalFrameHeightRefitState
} from './terminal-viewport-refit-state'

describe('terminal viewport refit', () => {
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

  it('falls back to legacy resubscribe when an older desktop lacks updateViewport', () => {
    const unsupported = {
      id: 'old-host',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: terminal.updateViewport' },
      _meta: { runtimeId: 'runtime' }
    } satisfies RpcResponse
    expect(terminalViewportUpdate.interpret(unsupported)).toBe(null)
    expect(
      resolveTerminalUpdateViewportCapability({
        ...unsupported,
        error: { code: 'temporary_failure', message: 'retryable' }
      })
    ).toBe('unknown')
    // A method_not_found refusal latches the capability, so a refit stops re-probing.
    expect(resolveTerminalUpdateViewportCapability(unsupported)).toBe('unsupported')
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

    expect(terminalViewportUpdate.interpret(okUpdated)).toEqual({ updated: true, applied: true })
    expect(terminalViewportUpdate.interpret(okRecordedButNotApplied)).toEqual({
      updated: true,
      applied: false
    })
    expect(terminalViewportUpdate.interpret(okNotUpdated)).toEqual({
      updated: false,
      applied: false
    })
    // A refusal is not an outcome at all, which is what keeps the refit on its resubscribe path.
    expect(terminalViewportUpdate.interpret(failed)).toBe(null)
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
