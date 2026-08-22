import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTreeLoaderForTests,
  isWindowsProcessTableAvailable,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests
} from './windows-process-table'

const getAllProcesses = vi.fn()

const NATIVE = [
  { pid: 4, ppid: 0, name: 'System' },
  { pid: 100, ppid: 4, name: 'orca.exe', commandLine: '"C:/a b/orca.exe" --x', memory: 4096 }
]

describe('windows process table', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcesses.mockReset()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(NATIVE))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('maps native rows, defaulting an unreadable command line to empty', async () => {
    const rows = await readWindowsProcessTableFresh()
    expect(rows).toEqual([
      { pid: 4, ppid: 0, name: 'System', command: '', memoryBytes: undefined },
      {
        pid: 100,
        ppid: 4,
        name: 'orca.exe',
        command: '"C:/a b/orca.exe" --x',
        memoryBytes: 4096
      }
    ])
  })

  it('requests memory and command line together', async () => {
    await readWindowsProcessTableFresh()
    expect(getAllProcesses.mock.calls[0]?.[1]).toBe(3)
  })

  it('serves repeat reads from the shared snapshot', async () => {
    await readWindowsProcessTable()
    await readWindowsProcessTable()
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('rejects rather than reporting an empty machine when the module is absent', async () => {
    // A caller that reads "no processes" acts on it -- by declaring a tree dead,
    // or by concluding a shell has no children. Absence must not look like that.
    __setWindowsProcessTreeLoaderForTests(() => null)
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unavailable/)
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })

  it('rejects when the snapshot itself fails', async () => {
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(undefined))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow()
  })

  it('is unavailable off Windows without attempting a require', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    __setWindowsProcessTreeLoaderForTests()
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })
})
