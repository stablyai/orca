import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  proveProviderProcessIdentity,
  sweepOrphanedProviderGroup,
  retireProviderWatcher
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
  pgid: 4243,
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

  it('retires a stopped sibling watcher only after the provider group is absent', async () => {
    const sent: [number, NodeJS.Signals | 0][] = []
    const deps = {
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => {
        if (pgid === 4242 && signal === 0) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
        sent.push([pgid, signal])
      },
      readProcessRow: async () => ({ ...watcher, ppid: 1 })
    }
    await expect(retireProviderWatcher(identity, deps)).resolves.toBe('killed')
    expect(sent).toEqual([
      [4243, 0],
      [4243, 'SIGKILL']
    ])
    sent.length = 0
    await expect(
      retireProviderWatcher(identity, {
        ...deps,
        signalGroup: (pgid, signal) => {
          sent.push([pgid, signal])
        }
      })
    ).resolves.toBe('refused')
    expect(sent).toEqual([[4242, 0]])
  })

  it('does not retire a reused watcher PID even when the provider group is absent', async () => {
    const sent: [number, NodeJS.Signals | 0][] = []
    await expect(
      retireProviderWatcher(identity, {
        signalGroup: (pgid, signal) => {
          if (pgid === 4242 && signal === 0) {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          }
          sent.push([pgid, signal])
        },
        readProcessRow: async () => ({ ...watcher, startedAt: 'clock-tick:999' })
      })
    ).resolves.toBe('refused')
    expect(sent).toEqual([[4243, 0]])
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
