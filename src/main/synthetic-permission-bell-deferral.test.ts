import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyntheticPermissionBellDeferral } from './synthetic-permission-bell-deferral'
import { CODEX_ATTENTION_QUIET_MS } from '../shared/codex-attention-quiet-window'

const PANE = 'tab-1:leaf-a'
const OTHER_PANE = 'tab-1:leaf-b'

describe('SyntheticPermissionBellDeferral', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rings a pause the agent never resolves, one quiet window later', () => {
    const deferral = new SyntheticPermissionBellDeferral()
    const emit = vi.fn()

    deferral.defer(PANE, emit)
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS - 1)
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(deferral.hasPending(PANE)).toBe(false)
  })

  it('drops the BEL when the pause resolves inside the window (#13600)', () => {
    const deferral = new SyntheticPermissionBellDeferral()
    const emit = vi.fn()

    deferral.defer(PANE, emit)
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS - 1)
    expect(deferral.cancel(PANE)).toBe(true)

    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS * 4)
    expect(emit).not.toHaveBeenCalled()
  })

  it('cancels only the named pane', () => {
    const deferral = new SyntheticPermissionBellDeferral()
    const resolved = vi.fn()
    const stillWaiting = vi.fn()

    deferral.defer(PANE, resolved)
    deferral.defer(OTHER_PANE, stillWaiting)
    deferral.cancel(PANE)
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)

    expect(resolved).not.toHaveBeenCalled()
    expect(stillWaiting).toHaveBeenCalledTimes(1)
  })

  it('re-arming a pane replaces its pending BEL instead of queueing a second ring', () => {
    const deferral = new SyntheticPermissionBellDeferral()
    const first = vi.fn()
    const second = vi.fn()

    deferral.defer(PANE, first)
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS - 1)
    deferral.defer(PANE, second)
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('reports nothing to cancel for an unarmed pane', () => {
    const deferral = new SyntheticPermissionBellDeferral()

    expect(deferral.cancel(PANE)).toBe(false)
    expect(deferral.hasPending(PANE)).toBe(false)
  })

  it('cancelAll drops every pending BEL at window teardown', () => {
    const deferral = new SyntheticPermissionBellDeferral()
    const first = vi.fn()
    const second = vi.fn()

    deferral.defer(PANE, first)
    deferral.defer(OTHER_PANE, second)
    deferral.cancelAll()
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS * 4)

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(deferral.hasPending(OTHER_PANE)).toBe(false)
  })

  it('honors an injected window for callers that need a different cadence', () => {
    const deferral = new SyntheticPermissionBellDeferral(50)
    const emit = vi.fn()

    deferral.defer(PANE, emit)
    vi.advanceTimersByTime(50)

    expect(emit).toHaveBeenCalledTimes(1)
  })
})
