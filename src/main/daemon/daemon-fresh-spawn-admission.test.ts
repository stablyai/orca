import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonFreshSpawnAdmission } from './daemon-fresh-spawn-admission'

afterEach(() => vi.useRealTimers())

describe('daemon fresh spawn admission', () => {
  it('throttles failed health probes and recovers without replacing the service', async () => {
    vi.useFakeTimers()
    const probe = vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue(true)
    const admission = new DaemonFreshSpawnAdmission(probe)
    await expect(admission.recover()).resolves.toBe(false)
    await expect(admission.recover()).resolves.toBe(false)
    expect(probe).toHaveBeenCalledOnce()
    expect(admission.unavailable).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(admission.recover()).resolves.toBe(true)
    expect(admission.unavailable).toBe(false)
    await expect(admission.recover()).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('lets an explicit retry bypass the automatic cooldown', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const admission = new DaemonFreshSpawnAdmission(probe)
    await expect(admission.recover()).resolves.toBe(false)
    await expect(admission.recover(true)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
