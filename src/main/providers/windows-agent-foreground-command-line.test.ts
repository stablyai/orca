import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resetWindowsProcessRowsSnapshotForTests } from './windows-foreground-process-rows'
import { resolveWindowsAgentForegroundCommandLine } from './windows-agent-foreground-command-line'

type NativeProcessRow = { pid: number; ppid: number; name: string; commandLine?: string }

const getAllProcessesMock = vi.fn()

// Why: the native reader rejects a table without the querying process (a blocked snapshot).
function mockWindowsRows(rows: NativeProcessRow[]): void {
  getAllProcessesMock.mockImplementation((cb: (snapshot: NativeProcessRow[]) => void) => {
    cb([{ pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }, ...rows])
  })
}

describe('resolveWindowsAgentForegroundCommandLine', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcessesMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it("returns the pane's foreground agent command line from the native table", async () => {
    mockWindowsRows([
      { pid: 100, ppid: 99, name: 'pwsh.exe', commandLine: 'pwsh.exe -NoLogo' },
      {
        pid: 101,
        ppid: 100,
        name: 'opencode.exe',
        commandLine: '"C:\\Program Files\\OpenCode\\opencode.exe" run fix the bug'
      }
    ])

    await expect(resolveWindowsAgentForegroundCommandLine(100, 'opencode.exe')).resolves.toBe(
      '"C:\\Program Files\\OpenCode\\opencode.exe" run fix the bug'
    )
  })

  it('returns null when the pane holds no such agent or the table misses the pane', async () => {
    mockWindowsRows([{ pid: 100, ppid: 99, name: 'pwsh.exe', commandLine: 'pwsh.exe' }])
    await expect(resolveWindowsAgentForegroundCommandLine(100, 'opencode.exe')).resolves.toBeNull()
    resetWindowsProcessRowsSnapshotForTests()
    await expect(resolveWindowsAgentForegroundCommandLine(555, 'opencode.exe')).resolves.toBeNull()
  })
})
