import { describe, expect, it, vi } from 'vitest'

import {
  classifyWindowsTreeKillTarget,
  verifyWindowsTreeKillTarget,
  WINDOWS_ROOT_IDENTITY_TIMEOUT_MS
} from './windows-pty-root-identity'
// The native reader rejects snapshots that omit the querying process.

const ORCA_PID = 5000

function link(pid: number, ppid: number): { pid: number; ppid: number } {
  return { pid, ppid }
}

const SYSTEM_CHAIN = [link(4, 0), link(700, 4), link(900, 700)]

describe('classifyWindowsTreeKillTarget', () => {
  it('accepts a ConPTY shell spawned directly by this process', () => {
    const rows = [...SYSTEM_CHAIN, link(ORCA_PID, 900), link(4242, ORCA_PID)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('own')
  })

  it('accepts a winpty shell reached through the winpty-agent hop', () => {
    const rows = [link(ORCA_PID, 900), link(6100, ORCA_PID), link(4242, 6100)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('own')
  })

  it('rejects a recycled pid whose ancestry never reaches this process', () => {
    const rows = [...SYSTEM_CHAIN, link(ORCA_PID, 900), link(4242, 900)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('foreign')
  })

  it('reports an exited root as absent rather than sweeping a stale pid', () => {
    const rows = [...SYSTEM_CHAIN, link(ORCA_PID, 900)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('absent')
  })

  it('rejects a recycled pid whose parent has itself already exited', () => {
    const rows = [link(ORCA_PID, 900), link(4242, 31337)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('foreign')
  })

  it('rejects a chain longer than the ConPTY/winpty depth even if Orca is above it', () => {
    const rows = [
      link(ORCA_PID, 900),
      link(10, ORCA_PID),
      link(11, 10),
      link(12, 11),
      link(13, 12),
      link(4242, 13)
    ]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('foreign')
  })

  it('never force-kills this process tree when the root pid is our own pid', () => {
    const rows = [link(ORCA_PID, 900)]
    expect(classifyWindowsTreeKillTarget(ORCA_PID, rows, ORCA_PID)).toBe('foreign')
  })

  it('treats duplicate rows for the root as unknown, not as ownership', () => {
    const rows = [link(4242, ORCA_PID), link(4242, 900)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('unknown')
  })

  it('treats a cyclic table as unknown instead of looping', () => {
    const rows = [link(4242, 4243), link(4243, 4242)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('unknown')
  })
})

describe('verifyWindowsTreeKillTarget', () => {
  it('returns unknown when the Windows process table is unavailable', async () => {
    const readRows = vi.fn().mockResolvedValue(null)
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'win32' })
    ).resolves.toBe('unknown')
  })

  it('returns unknown when the process query rejects', async () => {
    const readRows = vi.fn().mockRejectedValue(new Error('process table unavailable'))
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'win32' })
    ).resolves.toBe('unknown')
  })

  it('returns unknown when the query throws synchronously', async () => {
    const readRows = vi.fn(() => {
      throw new Error('spawn EPERM')
    })
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'win32' })
    ).resolves.toBe('unknown')
  })

  it('does not let a wedged process query block teardown past the deadline', async () => {
    vi.useFakeTimers()
    try {
      const readRows = vi.fn(() => new Promise<never>(() => {}))
      const pending = verifyWindowsTreeKillTarget(4242, {
        readRows,
        ownerPid: ORCA_PID,
        platform: 'win32'
      })
      await vi.advanceTimersByTimeAsync(WINDOWS_ROOT_IDENTITY_TIMEOUT_MS)
      await expect(pending).resolves.toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })
})
