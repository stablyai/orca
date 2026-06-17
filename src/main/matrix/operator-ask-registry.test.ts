import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasPendingAsk, registerAsk, resolveAsk } from './operator-ask-registry'

describe('operator-ask-registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('resolves with the operator answer when resolveAsk is called', async () => {
    const promise = registerAsk('pane-1', 10_000)
    expect(hasPendingAsk('pane-1')).toBe(true)

    const consumed = resolveAsk('pane-1', 'go ahead')
    expect(consumed).toBe(true)

    await expect(promise).resolves.toEqual({ answered: true, answer: 'go ahead' })
    expect(hasPendingAsk('pane-1')).toBe(false)
  })

  it('settles with a timeout outcome when no reply arrives', async () => {
    const promise = registerAsk('pane-2', 5_000)
    vi.advanceTimersByTime(5_000)

    await expect(promise).resolves.toEqual({ answered: false, reason: 'timeout' })
    expect(hasPendingAsk('pane-2')).toBe(false)
  })

  it('supersedes an earlier ask for the same pane key', async () => {
    const first = registerAsk('pane-3', 10_000)
    const second = registerAsk('pane-3', 10_000)

    await expect(first).resolves.toEqual({ answered: false, reason: 'superseded' })
    expect(hasPendingAsk('pane-3')).toBe(true)

    resolveAsk('pane-3', 'answer to second')
    await expect(second).resolves.toEqual({ answered: true, answer: 'answer to second' })
    expect(hasPendingAsk('pane-3')).toBe(false)
  })

  it('does not evict a superseding waiter when the old one settles', async () => {
    registerAsk('pane-4', 10_000)
    registerAsk('pane-4', 10_000)
    // The supersede already settled the first; the map must still hold the new one.
    expect(hasPendingAsk('pane-4')).toBe(true)
  })

  it('resolveAsk returns false and reports no pending ask when none registered', () => {
    expect(hasPendingAsk('pane-5')).toBe(false)
    expect(resolveAsk('pane-5', 'noop')).toBe(false)
  })

  it('clears the timeout once answered (no late timeout settle)', async () => {
    const promise = registerAsk('pane-6', 5_000)
    resolveAsk('pane-6', 'early')
    await expect(promise).resolves.toEqual({ answered: true, answer: 'early' })
    // Advancing past the timeout must not throw or re-settle.
    vi.advanceTimersByTime(10_000)
    expect(hasPendingAsk('pane-6')).toBe(false)
  })
})
