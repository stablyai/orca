import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'
// A real snapshot always contains the process doing the querying; the reader
// rejects a table without it, because that is what a blocked
// CreateToolhelp32Snapshot looks like (an empty list, not an error).
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

describe('Pi Windows foreground recognition', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcessesMock.mockReset()
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

  it('recognizes the npm entrypoint within the active ConPTY', async () => {
    const rows = [
      {
        pid: 100,
        ppid: 99,
        name: 'bash.exe',
        commandLine: '"C:\\Program Files\\Git\\usr\\bin\\bash.exe"'
      },
      {
        pid: 101,
        ppid: 100,
        name: 'node.exe',
        commandLine:
          'node.exe C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'
      }
    ]
    getAllProcessesMock.mockImplementation((cb: (snapshot: unknown) => void) => {
      cb(withSelf(rows))
    })
    const readWindowsConsoleAttachedProcessIds = vi.fn(async () => new Set([100, 101]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'node.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'pi', processId: 101 })
    expect(readWindowsConsoleAttachedProcessIds).toHaveBeenCalledTimes(1)
  })

  it('anchors a collapsed omp name to the omp pid, not the embedded pi leaf', async () => {
    // Pi restarts under a live OMP; an anchor on pi's pid would read that as
    // OMP's exit and fire a false "agent done" when the next snapshot degrades.
    const rows = [
      { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
      { pid: 101, ppid: 100, name: 'omp.exe', commandLine: 'omp' },
      {
        pid: 102,
        ppid: 101,
        name: 'node.exe',
        commandLine:
          'node.exe C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'
      }
    ]
    getAllProcessesMock.mockImplementation((cb: (snapshot: unknown) => void) => {
      cb(withSelf(rows))
    })
    const readWindowsConsoleAttachedProcessIds = vi.fn(async () => new Set([100, 101, 102]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'powershell.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'omp', processId: 101 })
  })
})
