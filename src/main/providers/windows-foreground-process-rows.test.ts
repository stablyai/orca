import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import {
  __setWindowsProcessTreeLoaderForTests,
  readWindowsProcessIdentityTable
} from '../windows/windows-process-table'
import {
  queryWindowsProcessDescendants,
  queryWindowsProcessLinksFresh,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'
// Empty Toolhelp snapshots can mean denial; include the querying process to prove readability.
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

const NATIVE_ROWS = [
  {
    pid: 100,
    ppid: 50,
    name: 'powershell.exe',
    commandLine: '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile'
  },
  {
    pid: 200,
    ppid: 100,
    name: 'node.exe',
    commandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js'
  }
]

describe('windows process rows', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcessesMock.mockReset()
    getAllProcessesMock.mockImplementation((cb: (rows: unknown) => void) => {
      cb(withSelf(NATIVE_ROWS))
    })
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  const scanCount = (): number => getAllProcessesMock.mock.calls.length

  it('rejects a snapshot that does not contain the querying process', async () => {
    // A missing self PID invalidates the table; false empty evidence could authorize teardown.
    getAllProcessesMock.mockImplementation((cb: (rows: unknown) => void) => {
      cb([{ pid: 100, ppid: 50, name: 'other.exe', commandLine: 'other' }])
    })
    resetWindowsProcessRowsSnapshotForTests()

    expect(await queryWindowsProcessDescendants(100, { fresh: true })).toBeNull()
  })

  it('reports an unreadable table as unavailable, not as an empty machine', async () => {
    // Unreadability cannot stand in for observed process absence.
    getAllProcessesMock.mockImplementation((cb: (rows: unknown) => void) => {
      cb(undefined)
    })
    resetWindowsProcessRowsSnapshotForTests()

    expect(await queryWindowsProcessDescendants(100, { fresh: true })).toBeNull()
    expect(await queryWindowsProcessDescendants(100)).toBeNull()
  })

  it('returns null when the root is absent from the snapshot', async () => {
    expect(await queryWindowsProcessDescendants(999)).toBeNull()
  })

  it('collapses a burst of concurrent identity probes into one scan', async () => {
    // A worktree delete tears down PTYs 32-wide.
    const rows = await Promise.all(
      Array.from({ length: 32 }, () => queryWindowsProcessDescendants(100, { fresh: true }))
    )

    expect(scanCount()).toBe(1)
    expect(rows[31]?.map((row) => row.pid)).toEqual([200])
  })

  it('never answers the ancestry links from the identity TTL cache either', async () => {
    // Ancestry uses a separate identity TTL cache; fresh teardown must bypass that cache too.
    await readWindowsProcessIdentityTable()
    getAllProcessesMock.mockImplementation((cb: (rows: unknown) => void) => {
      cb(withSelf([{ pid: 300, ppid: 100, name: 'node.exe' }]))
    })
    expect((await readWindowsProcessIdentityTable()).map((row) => row.pid)).toEqual([
      process.pid,
      100,
      200
    ])
    expect(scanCount()).toBe(1)

    const links = await queryWindowsProcessLinksFresh()

    expect(scanCount()).toBe(2)
    expect(links.map((row) => row.pid)).toEqual([process.pid, 300])
  })
})
