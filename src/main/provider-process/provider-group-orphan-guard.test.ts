import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  proveProviderProcessIdentity,
  sweepOrphanedProviderGroup
} from './provider-group-orphan-guard'
import type { ProviderProcessRow } from './provider-process-row-read'

const leader: ProviderProcessRow = {
  pid: 4242,
  ppid: 777,
  pgid: 4242,
  startedAt: 'clock-tick:123',
  startResolution: 'clock-tick'
}
const watcher: ProviderProcessRow = {
  ...leader,
  pid: 4243,
  ppid: 4242,
  startedAt: 'clock-tick:124'
}
const identity = { pgid: 4242, leader, watcher }
afterEach(() => vi.useRealTimers())

describe('provider group ownership', () => {
  it('can reap a leaderless group through the recorded watcher after reparenting', async () => {
    const signalGroup = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        signalGroup,
        readProcessRow: async (pid) => (pid === 4243 ? { ...watcher, ppid: 1 } : null)
      })
    ).resolves.toBe('killed')
    expect(signalGroup).toHaveBeenLastCalledWith(4242, 'SIGKILL')
  })

  it('refuses a group when both recorded PIDs were reused or cannot be read', async () => {
    const signalGroup = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        signalGroup,
        readProcessRow: async (pid) =>
          pid === 4242 ? 'unverifiable' : { ...watcher, startedAt: 'clock-tick:999' }
      })
    ).resolves.toBe('refused')
    expect(signalGroup).not.toHaveBeenCalledWith(4242, 'SIGKILL')
  })

  it('rejects same-second PID reuse when ancestry changes across the boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-14T10:00:00.100Z'))
    const row: ProviderProcessRow = {
      ...leader,
      startedAt: new Date('2026-11-14T10:00:00Z').toString(),
      startResolution: 'second'
    }
    const read = vi
      .fn()
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, ppid: 1 })
    const proving = proveProviderProcessIdentity(4242, read)
    await vi.advanceTimersByTimeAsync(1_100)
    await expect(proving).resolves.toBeNull()
  })
})
