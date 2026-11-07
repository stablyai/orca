import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'

type NativeProcessRow = { pid: number; ppid: number; name: string; commandLine?: string }

const getAllProcessesMock = vi.fn()
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const CURSOR = String.raw`C:\Users\dev\AppData\Local\cursor-agent`
const SHELL_PID = 100

// Measured in a Git Bash pane: MSYS exec let the fork stub (pid 103) exit, orphaning the cursor-agent script chain.
const GIT_BASH_CURSOR_ROWS: NativeProcessRow[] = [
  { pid: SHELL_PID, ppid: 99, name: 'bash.exe', commandLine: 'bash.exe' },
  { pid: 101, ppid: SHELL_PID, name: 'bash.exe', commandLine: 'bash.exe -c "exec $BASH"' },
  { pid: 102, ppid: 101, name: 'bash.exe', commandLine: 'bash.exe --rcfile C:/rc' },
  {
    pid: 110,
    ppid: 103,
    name: 'sh.exe',
    commandLine: String.raw`"C:\Program Files\Git\usr\bin\sh.exe" /c/Users/dev/AppData/Local/cursor-agent/cursor-agent --yolo`
  },
  { pid: 111, ppid: 110, name: 'cmd.exe', commandLine: `cmd.exe /c ${CURSOR}\\cursor-agent.cmd` },
  {
    pid: 112,
    ppid: 111,
    name: 'powershell.exe',
    commandLine: `powershell.exe -File "${CURSOR}\\cursor-agent.ps1"`
  },
  {
    pid: 113,
    ppid: 112,
    name: 'node.exe',
    commandLine: `"${CURSOR}\\versions\\1\\node.exe" ${CURSOR}\\versions\\1\\index.js`
  }
]
const CONSOLE_PROCESS_IDS = new Set(GIT_BASH_CURSOR_ROWS.map((row) => row.pid))

function mockWindowsRows(rows: NativeProcessRow[]): void {
  getAllProcessesMock.mockImplementation((cb: (snapshot: NativeProcessRow[]) => void) => {
    cb([SELF_PROCESS_ROW, ...rows])
  })
}

describe('Windows agent foreground behind an MSYS exec', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcessesMock.mockReset()
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

  it('finds a console-attached agent whose Win32 parent exited', async () => {
    mockWindowsRows(GIT_BASH_CURSOR_ROWS)
    const readConsole = vi.fn(async () => CONSOLE_PROCESS_IDS)

    await expect(
      resolveAgentForegroundProcessWithAvailability(SHELL_PID, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toEqual({ available: true, processName: 'cursor-agent', processId: 113 })
    // The orphan lookup and the detached-agent filter share one console read.
    expect(readConsole).toHaveBeenCalledTimes(1)
  })

  it('keeps the shell when the orphaned agent is not on the pane console', async () => {
    mockWindowsRows(GIT_BASH_CURSOR_ROWS)

    await expect(
      resolveAgentForegroundProcessWithAvailability(SHELL_PID, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => new Set([SHELL_PID, 101, 102])
      })
    ).resolves.toEqual({ available: true, processName: 'bash.exe' })
  })

  it('does not read the console for an idle native shell', async () => {
    mockWindowsRows([{ pid: SHELL_PID, ppid: 99, name: 'pwsh.exe', commandLine: 'pwsh.exe' }])
    const readConsole = vi.fn(async () => new Set([SHELL_PID]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(SHELL_PID, 'pwsh.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toEqual({ available: true, processName: 'pwsh.exe' })
    expect(readConsole).not.toHaveBeenCalled()
  })
})
