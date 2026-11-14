import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  guardSupervisedProviderGroup,
  sweepOrphanedProviderGroup
} from './provider-group-orphan-guard'
import type { ProcessRowRead } from './provider-process-row-read'

const STARTED = 'Mon Oct 19 10:00:00 2026'
const identity = { pgid: 4242, startedAt: STARTED }

function row(overrides: Partial<Exclude<ProcessRowRead, null | 'unverifiable'>> = {}) {
  return {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    startedAt: STARTED,
    startResolution: 'second' as const,
    ...overrides
  }
}

describe('sweepOrphanedProviderGroup', () => {
  it('kills a surviving group whose leader is the recorded process', async () => {
    const signalGroup = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        site: 'test',
        supervised: true,
        signalGroup,
        readProcessRow: async () => row()
      })
    ).resolves.toBe('killed')
    expect(signalGroup).toHaveBeenLastCalledWith(4242, 'SIGKILL')
  })

  it('refuses a leaderless group, which nothing can prove is still ours', async () => {
    const signalGroup = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        site: 'test',
        supervised: true,
        signalGroup,
        readProcessRow: async () => null
      })
    ).resolves.toBe('refused')
    expect(signalGroup).not.toHaveBeenCalledWith(4242, 'SIGKILL')
  })

  it.each<[string, ProcessRowRead]>([
    ['a reused pid with another start time', row({ startedAt: 'Mon Oct 19 11:00:00 2026' })],
    ['a reused pid leading another group', row({ pgid: 99 })],
    ['a failed process read', 'unverifiable']
  ])('refuses %s', async (_label, leader) => {
    const signalGroup = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        site: 'test',
        supervised: true,
        signalGroup,
        readProcessRow: async () => leader
      })
    ).resolves.toBe('refused')
    expect(signalGroup).not.toHaveBeenCalledWith(4242, 'SIGKILL')
  })
})

class FakeSupervisor extends EventEmitter {
  pid = 777
  connected = true
  report(message: unknown): void {
    this.emit('message', message)
    this.connected = false
    this.emit('disconnect')
  }
}

describe('guardSupervisedProviderGroup', () => {
  it('arms nothing when a same-second replacement holds the pid once the second ends', async () => {
    const child = new FakeSupervisor()
    const clock = { now: Date.parse(STARTED) + 300 }
    // The first read is our leader; by the re-read its pid names a stranger with the same lstart.
    const readProcessRow = vi
      .fn<(pid: number) => Promise<ProcessRowRead>>()
      .mockResolvedValueOnce(row({ ppid: 777 }))
      .mockResolvedValueOnce(row({ ppid: 1 }))
    const signalGroup = vi.fn()
    const swept = new Promise((resolve) =>
      guardSupervisedProviderGroup(child, {
        site: 'test',
        supervised: true,
        readProcessRow,
        signalGroup,
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms
        },
        onSwept: resolve
      })
    )
    child.report({ pgid: 4242 })
    await vi.waitFor(() => expect(readProcessRow).toHaveBeenCalledTimes(2))
    child.emit('exit', null, 'SIGKILL')
    await expect(swept).resolves.toBe('unproven')
    expect(signalGroup).not.toHaveBeenCalled()
  })
})

it('sweeps a proven group once on actual supervisor absence, but not on connection failure', async () => {
  const child = new FakeSupervisor()
  const signalGroup = vi.fn()
  const proven = Promise.withResolvers<void>()
  const swept = Promise.withResolvers<unknown>()
  guardSupervisedProviderGroup(child, {
    site: 'test',
    supervised: true,
    signalGroup,
    now: () => Date.parse(STARTED) + 2_000,
    readProcessRow: async () => row({ ppid: child.connected ? 777 : 1 }),
    onProven: () => proven.resolve(),
    onSwept: swept.resolve
  })
  child.emit('message', { pgid: 4242 })
  await proven.promise
  child.on('error', () => {})
  child.emit('error', new Error('Connection lost'))
  expect(signalGroup).not.toHaveBeenCalled()
  child.connected = false
  child.emit('disconnect')
  child.emit('providerAbsent')
  child.emit('exit')
  await expect(swept.promise).resolves.toBe('killed')
  expect(signalGroup).toHaveBeenCalledTimes(2)
  expect(signalGroup).toHaveBeenLastCalledWith(4242, 'SIGKILL')
})
