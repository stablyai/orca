import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from './windows/windows-process-table'
import {
  classifyWindowsTreeKillTarget,
  verifyWindowsTreeKillTarget,
  WINDOWS_ROOT_IDENTITY_TIMEOUT_MS
} from './windows-pty-root-identity'
// A real snapshot always contains the process doing the querying; the reader
// rejects a table without it, because that is what a blocked
// CreateToolhelp32Snapshot looks like (an empty list, not an error).
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

const ORCA_PID = 5000

function link(pid: number, ppid: number): { pid: number; ppid: number } {
  return { pid, ppid }
}

/** Windows: services.exe → svchost.exe, a chain that never reaches Orca. */
const SYSTEM_CHAIN = [link(4, 0), link(700, 4), link(900, 700)]

describe('classifyWindowsTreeKillTarget', () => {
  it('accepts a ConPTY shell spawned directly by this process', () => {
    const rows = [...SYSTEM_CHAIN, link(ORCA_PID, 900), link(4242, ORCA_PID)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('own')
  })

  it('accepts a winpty shell reached through the winpty-agent hop', () => {
    // node-pty falls back to winpty below Windows build 18309, so the shell's
    // parent is winpty-agent.exe rather than Orca itself.
    const rows = [link(ORCA_PID, 900), link(6100, ORCA_PID), link(4242, 6100)]
    expect(classifyWindowsTreeKillTarget(4242, rows, ORCA_PID)).toBe('own')
  })

  it('documents that a recycled PID under another Orca pane still classifies as own', () => {
    // Dead PTY root 4242 recycled as a tool under a different pane's agent tree.
    // Ancestry still reaches us, so taskkill is allowed — wrong process, own tree.
    // Closing this needs spawn-time CreationDate / Job Object (#10680).
    const rows = [link(ORCA_PID, 900), link(7000, ORCA_PID), link(7100, 7000), link(4242, 7100)]
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
    // The orphan's ppid names a vacated pid, so the chain dead-ends away from us.
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

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid root pid %s', (rootPid) => {
    expect(classifyWindowsTreeKillTarget(rootPid, [link(4242, ORCA_PID)], ORCA_PID)).toBe('foreign')
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
  it('classifies a live win32 root against the fresh process table', async () => {
    const readRows = vi.fn().mockResolvedValue([link(4242, ORCA_PID)])
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'win32' })
    ).resolves.toBe('own')
    expect(readRows).toHaveBeenCalledOnce()
  })

  it('detects the recycled-pid case that taskkill /T /F must not touch', async () => {
    const readRows = vi.fn().mockResolvedValue([link(4242, 900), link(900, 4)])
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'win32' })
    ).resolves.toBe('foreign')
  })

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

  it('skips the probe off Windows so POSIX teardown keeps its own guards', async () => {
    const readRows = vi.fn()
    await expect(
      verifyWindowsTreeKillTarget(4242, { readRows, ownerPid: ORCA_PID, platform: 'darwin' })
    ).resolves.toBe('unknown')
    expect(readRows).not.toHaveBeenCalled()
  })
})

// Regression guard on the DEFAULT reader, which the cases above bypass by
// injecting readRows: worktree delete tears down PTYs 32-wide, so a probe that
// reads the table uncached takes 32 full process-table scans per delete — the
// churn #6288/#6667 fixed for POSIX. Exercises the real wiring, not a fake.
describe('verifyWindowsTreeKillTarget scan volume', () => {
  const NATIVE_ROWS = [
    { pid: ORCA_PID, ppid: 900, name: 'orca.exe', commandLine: 'orca.exe' },
    { pid: 4242, ppid: ORCA_PID, name: 'pwsh.exe', commandLine: 'pwsh.exe' }
  ]

  beforeEach(() => {
    getAllProcessesMock.mockReset()
    getAllProcessesMock.mockImplementation((cb: (snapshot: unknown) => void) => {
      cb(withSelf(NATIVE_ROWS))
    })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
  })

  it('collapses a 32-wide teardown burst into a single process-table scan', async () => {
    const verdicts = await Promise.all(
      Array.from({ length: 32 }, () =>
        verifyWindowsTreeKillTarget(4242, { ownerPid: ORCA_PID, platform: 'win32' })
      )
    )

    expect(getAllProcessesMock.mock.calls.length).toBe(1)
    expect(new Set(verdicts)).toEqual(new Set(['own']))
  })
})
