/**
 * The scan that gates PTY teardown used to fork `powershell.exe` (with a `wmic`
 * fallback) on a ~1s/pane cadence. Two of the cases this suite used to carry —
 * "the powershell probe passes windowsHide" and "the wmic fallback passes
 * windowsHide" — are gone because there is no child process to hide any more.
 *
 * What survives is the contract that does not depend on the mechanism: a
 * teardown-time read must be fresh, and a 32-wide worktree delete must still
 * collapse into one scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  queryWindowsProcessDescendants,
  queryWindowsProcessRowsFresh,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

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
      cb(NATIVE_ROWS)
    })
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
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

  it('walks descendants from the native snapshot', async () => {
    const candidates = await queryWindowsProcessDescendants(100)
    expect(candidates?.[0]?.pid).toBe(200)
  })

  it('recovers the image path from a quoted command line', async () => {
    // Why keep this at all: agent matching used to get ExecutablePath as its own
    // CIM column. The command line already starts with the same path, so the
    // column was a cost with no extra information.
    const rows = await queryWindowsProcessRowsFresh()
    expect(rows.find((row) => row.pid === 100)?.executablePath).toBe(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    expect(rows.find((row) => row.pid === 200)?.executablePath).toBe('node')
  })

  it('reports an unreadable table as unavailable, not as an empty machine', async () => {
    // An empty table is a claim that nothing is running, and callers act on it
    // by declaring a tree dead. Unavailable has to stay distinguishable.
    getAllProcessesMock.mockImplementation((cb: (rows: unknown) => void) => {
      cb(undefined)
    })
    resetWindowsProcessRowsSnapshotForTests()

    await expect(queryWindowsProcessRowsFresh()).rejects.toThrow()
    expect(await queryWindowsProcessDescendants(100)).toBeNull()
  })

  it('returns null when the root is absent from the snapshot', async () => {
    // Only an observed root can authoritatively have no descendants.
    expect(await queryWindowsProcessDescendants(999)).toBeNull()
  })

  it('collapses a burst of concurrent identity probes into one scan', async () => {
    // A worktree delete tears down PTYs 32-wide.
    const rows = await Promise.all(Array.from({ length: 32 }, () => queryWindowsProcessRowsFresh()))

    expect(scanCount()).toBe(1)
    expect(rows[31]?.map((row) => row.pid)).toEqual([100, 200])
  })

  it('never answers from the TTL cache, which can predate the recycle it detects', async () => {
    await queryWindowsProcessDescendants(100)
    expect(scanCount()).toBe(1)

    await queryWindowsProcessRowsFresh()

    expect(scanCount()).toBe(2)
  })
})
