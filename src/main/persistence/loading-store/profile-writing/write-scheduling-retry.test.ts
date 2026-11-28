import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { retryParkedSaves } from './refused-save-retry'

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduled profile save', () => {
  it('retries a refused save without waiting for another change', async () => {
    const { store, authority, readState } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    authority.failNextWrite()
    store.updateSettings({ workspaceDir: '/retried-workspace' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(readState().settings.workspaceDir).not.toBe('/retried-workspace')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(readState().settings.workspaceDir).toBe('/retried-workspace')
  })

  it('keeps retrying while the writer retires and stops once saving has stopped for good', async () => {
    const { store, authority } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    authority.failNextWrite(Number.POSITIVE_INFINITY)
    store.updateSettings({ workspaceDir: '/never-saved' })

    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 10_000)
    expect(authority.writeFailures).toBe(3)
    authority.savingStopped = true
    await vi.advanceTimersByTimeAsync(20_000)
    const attempts = authority.writeFailures
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(authority.writeFailures).toBe(attempts)
  })

  it('retries a refused flush of already-saved state through the writer', async () => {
    const { store, authority } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    authority.failNextWrite()
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow()
    const afterRefusal = authority.commands

    await vi.advanceTimersByTimeAsync(5_000)
    expect(authority.commands).toBeGreaterThan(afterRefusal)
  })

  it('retries a refused flush through the writer even when the flush wait timed out', async () => {
    const { store, authority } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gate = authority.pause()
    authority.failNextWrite()
    const deadline = new AbortController()
    const flushed = store.flushPendingOrThrowAsync({ signal: deadline.signal }).catch(() => {})
    await gate.started.promise
    deadline.abort()
    gate.finish.resolve()
    await flushed
    await vi.advanceTimersByTimeAsync(0)
    const afterRefusal = authority.commands

    await vi.advanceTimersByTimeAsync(5_000)
    expect(authority.commands).toBeGreaterThan(afterRefusal)
  })

  it('stops its timer after the 40 s retry and saves when the user comes back', async () => {
    const { store, authority, readState } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    authority.failNextWrite(Number.POSITIVE_INFINITY)
    store.updateSettings({ workspaceDir: '/saved-on-focus' })

    // The scheduled save, then retries after 5, 10, 20 and 40 s.
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 10_000 + 20_000 + 40_000)
    expect(authority.writeFailures).toBe(5)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(authority.writeFailures).toBe(5)

    authority.failNextWrite(0)
    retryParkedSaves()
    await vi.advanceTimersByTimeAsync(0)
    expect(readState().settings.workspaceDir).toBe('/saved-on-focus')
  })

  it('drops a waiting retry once a later save lands', async () => {
    const { store, authority } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    authority.failNextWrite(5)
    store.updateSettings({ workspaceDir: '/parked' })
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 10_000 + 20_000 + 40_000)
    store.updateSettings({ workspaceDir: '/saved-by-edit' })
    await vi.advanceTimersByTimeAsync(5_000)
    const afterEdit = authority.commands

    retryParkedSaves()
    await vi.advanceTimersByTimeAsync(0)
    expect(authority.commands).toBe(afterEdit)
  })
})
