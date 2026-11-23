import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

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
})
