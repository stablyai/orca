// Regression guard: the Windows agent foreground-process scan re-forks
// powershell.exe (or the wmic fallback) on a ~1s/pane cadence. Electron's main
// process has no console, so a spawn without windowsHide pops a fresh conhost
// window per scan that flashes and steals keyboard focus from the foreground app
// (including Orca's own terminal). Both probes MUST pass windowsHide: true.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

type ExecFileCallback = (err: unknown, result: { stdout: string; stderr: string }) => void
type ExecFileCall = [string, string[], Record<string, unknown>, ExecFileCallback]

const POWERSHELL_ROWS_JSON = JSON.stringify([
  {
    ProcessId: 100,
    ParentProcessId: 50,
    Name: 'powershell.exe',
    CommandLine: 'powershell.exe',
    ExecutablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  },
  {
    ProcessId: 200,
    ParentProcessId: 100,
    Name: 'node.exe',
    CommandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js',
    ExecutablePath: 'C:/Program Files/nodejs/node.exe'
  }
])

const WMIC_ROWS_VALUE =
  'CommandLine=powershell.exe\n' +
  'ExecutablePath=C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\n' +
  'Name=powershell.exe\n' +
  'ParentProcessId=50\n' +
  'ProcessId=100\n\n' +
  'CommandLine=node C:/Users/dev/AppData/codex/bin/codex.js\n' +
  'ExecutablePath=C:/Program Files/nodejs/node.exe\n' +
  'Name=node.exe\n' +
  'ParentProcessId=100\n' +
  'ProcessId=200\n'

/** Returns the options object passed to the mocked execFile for a given command. */
function optionsForCommand(command: string): Record<string, unknown> | undefined {
  const call = execFileMock.mock.calls.find((args) => (args as ExecFileCall)[0] === command) as
    | ExecFileCall
    | undefined
  return call?.[2]
}

describe('windows foreground process rows spawn options', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('hides the console window for the powershell process-table scan', async () => {
    execFileMock.mockImplementation((_cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(optionsForCommand('powershell.exe')).toMatchObject({ windowsHide: true })
  })

  it('hides the console window for the wmic fallback scan', async () => {
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      // Force the powershell probe to miss so the wmic fallback runs.
      if (cmd === 'powershell.exe') {
        cb(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      cb(null, { stdout: WMIC_ROWS_VALUE, stderr: '' })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(optionsForCommand('wmic')).toMatchObject({ windowsHide: true })
  })
})
