import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  guardSupervisedProviderGroup,
  sweepOrphanedProviderGroup,
  type ProviderGroupSweepVerdict
} from './provider-group-orphan-guard'
import type { ProcessRowRead } from './provider-process-row-read'

const STARTED = 'Mon Oct 19 10:00:00 2026'
const identity = { pgid: 4242, startedAt: STARTED }

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

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
  it('does nothing when the group is already gone', async () => {
    const signalGroup = vi.fn(() => {
      throw errno('ESRCH')
    })
    const readProcessRow = vi.fn()
    await expect(
      sweepOrphanedProviderGroup(identity, {
        site: 'test',
        supervised: true,
        signalGroup,
        readProcessRow
      })
    ).resolves.toBe('absent')
    expect(readProcessRow).not.toHaveBeenCalled()
  })

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

  it('refuses a group this user cannot signal', async () => {
    const signalGroup = vi.fn(() => {
      throw errno('EPERM')
    })
    await expect(
      sweepOrphanedProviderGroup(identity, { site: 'test', supervised: true, signalGroup })
    ).resolves.toBe('refused')
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

function guard(
  child: FakeSupervisor,
  readProcessRow: (pid: number) => Promise<ProcessRowRead>,
  signalGroup = vi.fn()
): Promise<ProviderGroupSweepVerdict | 'unproven'> {
  return new Promise((resolve) =>
    guardSupervisedProviderGroup(child, {
      site: 'test',
      supervised: true,
      readProcessRow,
      signalGroup,
      onSwept: resolve
    })
  )
}

describe('guardSupervisedProviderGroup', () => {
  it('sweeps the reported group once the supervisor exits', async () => {
    const child = new FakeSupervisor()
    const signalGroup = vi.fn()
    const swept = guard(child, async () => row({ ppid: 777 }), signalGroup)
    child.report({ pgid: 4242 })
    child.emit('exit', null, 'SIGKILL')
    await expect(swept).resolves.toBe('killed')
    expect(signalGroup).toHaveBeenLastCalledWith(4242, 'SIGKILL')
  })

  it('never records a reported pid that its supervisor no longer parents', async () => {
    const child = new FakeSupervisor()
    const signalGroup = vi.fn()
    const swept = guard(child, async () => row({ ppid: 1 }), signalGroup)
    child.report({ pgid: 4242 })
    child.emit('exit', null, 'SIGKILL')
    await expect(swept).resolves.toBe('unproven')
    expect(signalGroup).not.toHaveBeenCalled()
  })

  it('re-reads a leader started in the read second, so a same-second reuse cannot match', async () => {
    const child = new FakeSupervisor()
    const startedAtMs = Date.parse(STARTED)
    const clock = { now: startedAtMs + 300 }
    const readProcessRow = vi.fn(async () => row({ ppid: 777 }))
    const sleep = vi.fn(async (ms: number) => {
      clock.now += ms
    })
    const proven = new Promise((resolve) =>
      guardSupervisedProviderGroup(child, {
        site: 'test',
        supervised: true,
        readProcessRow,
        now: () => clock.now,
        sleep,
        onProven: resolve
      })
    )
    child.report({ pgid: 4242 })
    await expect(proven).resolves.toEqual(identity)
    expect(readProcessRow).toHaveBeenCalledTimes(2)
    expect(clock.now).toBeGreaterThanOrEqual(startedAtMs + 1_000)
  })

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

  it('trusts a Linux clock-tick start without waiting out the second', async () => {
    const child = new FakeSupervisor()
    const startedAt = 'clock-tick:123456'
    const readProcessRow = vi.fn(async () =>
      row({ ppid: 777, startedAt, startResolution: 'clock-tick' })
    )
    const sleep = vi.fn(async () => {})
    const proven = new Promise((resolve) =>
      guardSupervisedProviderGroup(child, {
        site: 'test',
        supervised: true,
        readProcessRow,
        now: () => Date.now(),
        sleep,
        onProven: resolve
      })
    )
    child.report({ pgid: 4242 })
    await expect(proven).resolves.toEqual({ pgid: 4242, startedAt })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('records nothing when every read stays inside the start second', async () => {
    const child = new FakeSupervisor()
    const now = Date.parse(STARTED) + 100
    const signalGroup = vi.fn()
    const swept = new Promise((resolve) =>
      guardSupervisedProviderGroup(child, {
        site: 'test',
        supervised: true,
        readProcessRow: async () => row({ ppid: 777 }),
        signalGroup,
        now: () => now,
        sleep: async () => {},
        onSwept: resolve
      })
    )
    child.report({ pgid: 4242 })
    child.emit('exit', null, 'SIGKILL')
    await expect(swept).resolves.toBe('unproven')
    expect(signalGroup).not.toHaveBeenCalled()
  })

  it('stops waiting out the start second as soon as the supervisor exits', async () => {
    const child = new FakeSupervisor()
    const readProcessRow = vi.fn(async () => row({ ppid: 777 }))
    const swept = new Promise((resolve) =>
      guardSupervisedProviderGroup(child, {
        site: 'test',
        supervised: true,
        readProcessRow,
        now: () => Date.parse(STARTED) + 100,
        onSwept: resolve
      })
    )
    child.report({ pgid: 4242 })
    await vi.waitFor(() => expect(readProcessRow).toHaveBeenCalledTimes(1))
    const exitedAt = performance.now()
    child.emit('exit', null, 'SIGKILL')
    await expect(swept).resolves.toBe('unproven')
    expect(performance.now() - exitedAt).toBeLessThan(500)
    expect(readProcessRow).toHaveBeenCalledTimes(1)
  })

  it('warns once and watches nothing for a supervised spawn without the report channel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = new FakeSupervisor()
    child.connected = false
    expect(guardSupervisedProviderGroup(child, { site: 'test', supervised: true })).toBe(false)
    expect(guardSupervisedProviderGroup(child, { site: 'test', supervised: true })).toBe(false)
    expect(child.listenerCount('exit')).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('stays quiet for an unsupervised spawn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      guardSupervisedProviderGroup(new FakeSupervisor(), { site: 'test', supervised: false })
    ).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores a malformed report', async () => {
    const child = new FakeSupervisor()
    const readProcessRow = vi.fn(async () => row({ ppid: 777 }))
    const swept = guard(child, readProcessRow)
    child.report({ pgid: 1 })
    child.emit('exit', 0, null)
    await expect(swept).resolves.toBe('unproven')
    expect(readProcessRow).not.toHaveBeenCalled()
  })
})
