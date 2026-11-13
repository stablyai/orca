import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

const getAllProcessesMock = vi.fn()

import { resetProcessTableSnapshotForTests } from '../../../shared/process-table-snapshot-reader'
import { __setWindowsProcessTreeLoaderForTests } from '../../windows/windows-process-table'
import {
  confirmShellForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-process'
// Toolhelp denial may return an empty table; require the querying process to distinguish a readable snapshot.
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

// Why: the POSIX reader wraps execFile with promisify, so the mock must honor
// the Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

type NativeProcessRow = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
}

const DEFAULT_WINDOWS_ROWS: NativeProcessRow[] = [
  {
    pid: 100,
    ppid: 99,
    name: 'powershell.exe',
    commandLine: 'powershell.exe'
  },
  {
    pid: 101,
    ppid: 100,
    name: 'node.exe',
    commandLine: 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'
  }
]

function mockWindowsRows(rows: NativeProcessRow[] = DEFAULT_WINDOWS_ROWS): void {
  getAllProcessesMock.mockImplementation((cb: (snapshot: NativeProcessRow[]) => void) => {
    cb(withSelf(rows))
  })
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    getAllProcessesMock.mockReset()
    resetProcessTableSnapshotForTests()
    // Reset the 500ms Windows snapshot cache so each case reads its own rows.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  // Why: OMP embeds Pi, but the outer process is the user-visible identity (#6364).

  it('rejects a foreground nested shell while the spawned shell remains suspended', async () => {
    mockPs(
      [
        '100 99 100 102 Ss /usr/bin/login -pfl developer /bin/zsh',
        '101 100 101 102 S -zsh',
        '102 101 102 102 S+ agent-tui',
        '103 102 102 102 S+ /bin/zsh -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a stopped TUI remains resumable', async () => {
    mockPs(['100 99 100 100 Ss+ /bin/zsh -l', '101 100 101 100 T agent-tui'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('detects a foreign anchor even when the squatter is orphaned out of the descendant walk', async () => {
    // PID reuse can leave the squatter outside the shell ancestry while retaining job membership.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 500, name: 'node.exe', commandLine: 'node server.js' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999
      })
    ).resolves.toEqual({
      available: true,
      processName: 'powershell.exe',
      anchorPidForeign: true
    })
  })

  it('flags an anchor recycled by a DIFFERENT agent as foreign', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 500, name: 'node.exe', commandLine: 'node /usr/bin/codex' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999,
        anchorProcessName: 'claude'
      })
    ).resolves.toEqual({
      available: true,
      processName: 'powershell.exe',
      anchorPidForeign: true
    })
  })

  it('treats a query-denied anchor row as inconclusive, never foreign', async () => {
    // A denied query yields command === name; the agent may just be unreadable.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 999, ppid: 100, name: 'node.exe', commandLine: '' }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        anchorProcessId: 999
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })

  it('filters detached agents before resolving an otherwise ambiguous ConPTY tree', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'droid.exe',
        commandLine: 'droid'
      },
      {
        pid: 102,
        ppid: 100,
        name: 'agy.exe',
        commandLine: 'agy'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({
      available: true,
      processName: 'droid',
      processId: 101
    })
  })

  it('fails closed when console attachment cannot be read', async () => {
    // Unreadable console attachment cannot authorize a detached descendant as the pane agent (#16419).
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      { pid: 200, ppid: 199, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 201, ppid: 200, name: 'droid.exe', commandLine: 'droid' },
      { pid: 202, ppid: 200, name: 'agy.exe', commandLine: 'agy' }
    ])

    const reader = vi.fn(async () => null)

    const resolution = await resolveAgentForegroundProcessWithAvailability(200, 'powershell.exe', {
      fresh: true,
      readWindowsConsoleAttachedProcessIds: reader
    })

    expect(reader).toHaveBeenCalledTimes(1)
    // Unavailable evidence must yield the shell fallback, never an unverified agent identity.
    expect(resolution.available).toBe(false)
    expect(resolution.processName).toBe('powershell.exe')
  })

  it('excludes a detached Windows Droid descendant from byte authority', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWindowsRows([
      {
        pid: 100,
        ppid: 99,
        name: 'powershell.exe',
        commandLine: 'powershell.exe'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'droid.exe',
        commandLine: 'droid'
      }
    ])

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => new Set([100, 999])
      })
    ).resolves.toEqual({ available: true, processName: 'powershell.exe' })
  })
})
