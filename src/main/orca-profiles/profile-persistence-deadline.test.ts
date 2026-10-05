import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileStateMaintenance } from '../persistence/loading-store/profile-state-authority'
import type { ProfileStateMaintenanceOptions } from '../persistence/loading-store/profile-state-maintenance'
import { flushActiveProfileBeforeFileMutation } from './profile-persistence-deadline'

afterEach(() => vi.useRealTimers())

describe('profile persistence deadline', () => {
  it('allows the writer request deadline to finish before imposing maintenance cancellation', async () => {
    vi.useFakeTimers()
    const result = Promise.withResolvers<ProfileStateMaintenance>()
    const beginProfileMaintenance = vi.fn(
      (_options?: ProfileStateMaintenanceOptions) => result.promise
    )
    const pending = flushActiveProfileBeforeFileMutation({ beginProfileMaintenance })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(beginProfileMaintenance.mock.calls[0]?.[0]?.signal?.aborted).not.toBe(true)
    const handle = { resume: vi.fn(async () => {}) }
    result.resolve(handle)
    await expect(pending).resolves.toBe(handle)
    expect(handle.resume).not.toHaveBeenCalled()
  })

  it('resumes a clean pause that finishes after the caller times out', async () => {
    vi.useFakeTimers()
    const result = Promise.withResolvers<ProfileStateMaintenance>()
    const beginProfileMaintenance = vi.fn(() => result.promise)
    const pending = flushActiveProfileBeforeFileMutation({ beginProfileMaintenance })
    const rejected = expect(pending).rejects.toThrow('orca_profile_persistence_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    const handle = { resume: vi.fn(async () => {}) }
    result.resolve(handle)
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.resume).toHaveBeenCalledOnce()
  })
})
