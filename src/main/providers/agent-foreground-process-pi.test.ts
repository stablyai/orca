import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'
// Toolhelp denial may return an empty table; require the querying process to distinguish a readable snapshot.
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

  it.each(['cli.js', String.raw`bundle\cli.js`])(
    'recognizes the npm entrypoint dist/%s within the active ConPTY',
    async (entrypoint) => {
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
          commandLine: `node.exe C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\${entrypoint}`
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
    }
  )

  it.each(['cli.js', String.raw`bundle\cli.js`])(
    'anchors a collapsed omp name to the omp pid, not the embedded pi leaf at dist/%s',
    async (entrypoint) => {
      // Anchor OMP itself: embedded Pi restarts must not report a false OMP exit.
      const rows = [
        { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
        { pid: 101, ppid: 100, name: 'omp.exe', commandLine: 'omp' },
        {
          pid: 102,
          ppid: 101,
          name: 'node.exe',
          commandLine: `node.exe C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\${entrypoint}`
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
    }
  )
})
