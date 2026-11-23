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
})
