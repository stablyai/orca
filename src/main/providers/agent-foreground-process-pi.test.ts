import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'

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
      cb(rows)
    })
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 101]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'node.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'pi' })
    expect(readWindowsConptyProcessIds).toHaveBeenCalledTimes(1)
  })
})
