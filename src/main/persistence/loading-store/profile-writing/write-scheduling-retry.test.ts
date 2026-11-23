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

  it('stops retrying once saving has stopped for good', async () => {
    const { store, authority } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stopped = vi.spyOn(authority, 'assertWritable').mockImplementation(() => {
      throw new Error('Profile state writer was aborted')
    })
    store.updateSettings({ workspaceDir: '/never-saved' })

    await vi.advanceTimersByTimeAsync(1_000)
    const attempts = stopped.mock.calls.length
    expect(attempts).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(stopped.mock.calls.length).toBe(attempts)
    stopped.mockRestore()
  })
})
