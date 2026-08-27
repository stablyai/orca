import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTableCimScanForTests,
  __setWindowsProcessTreeLoaderForTests,
  __setWindowsProcessTreeRequireForTests,
  isWindowsProcessTableAvailable,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests
} from './windows-process-table'

const getAllProcesses = vi.fn()

// A real snapshot always contains the querying process; the reader rejects a
// table without it, because that is what a blocked CreateToolhelp32Snapshot
// returns -- an empty list rather than an error.
const SELF = { pid: process.pid, ppid: 0, name: 'vitest.exe' }
const NATIVE = [
  SELF,
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
      { pid: process.pid, ppid: 0, name: 'vitest.exe', command: '', memoryBytes: undefined },
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
    // or by concluding a shell has no children. Absence must not look like that,
    // and neither must a fallback that also fails.
    __setWindowsProcessTreeLoaderForTests(() => null)
    __setWindowsProcessTableCimScanForTests(async () => {
      throw new Error('powershell unavailable')
    })
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/powershell unavailable/)
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })

  it('rejects when the snapshot itself fails', async () => {
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(undefined))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow()
  })

  it('rejects an empty snapshot rather than reporting an idle machine', async () => {
    // CreateToolhelp32Snapshot failing under an EDR hook or a restricted token
    // yields an empty vector, not an error. Callers act on "nothing is running"
    // by concluding a live PTY root is already gone.
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
  })

  it('rejects when the snapshot never calls back', async () => {
    // The vendored reader latches a module-global on a wedge, so without a
    // deadline one hang kills the process table for the life of the app.
    vi.useFakeTimers()
    getAllProcesses.mockImplementation(() => {})
    resetWindowsProcessTableForTests()
    const pending = readWindowsProcessTableFresh()
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
    vi.useRealTimers()
  })

  it('is unavailable off Windows without attempting a require', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    __setWindowsProcessTreeLoaderForTests()
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })
})

// Why this path exists: relay deployment installs only node-pty and
// @parcel/watcher, so a Windows SSH host has no native binding and every read
// used to reject -- which agent recognition reads as "no evidence" forever.
describe('PowerShell fallback when the native binding is absent', () => {
  let platform: PropertyDescriptor | undefined
  const cimScan = vi.fn()
  const CIM_ROWS = [
    { pid: process.pid, ppid: 0, name: 'node.exe', command: 'node relay.js' },
    { pid: 200, ppid: process.pid, name: 'claude.exe', command: 'claude --resume' }
  ]

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    cimScan.mockReset()
    cimScan.mockResolvedValue(CIM_ROWS)
    __setWindowsProcessTableCimScanForTests(cimScan)
  })

  afterEach(() => {
    __setWindowsProcessTableCimScanForTests()
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('engages when the module cannot be required', async () => {
    __setWindowsProcessTreeLoaderForTests(() => null)
    await expect(readWindowsProcessTableFresh()).resolves.toEqual(CIM_ROWS)
    expect(cimScan).toHaveBeenCalledTimes(1)
  })

  it('does not engage when the native binding is present', async () => {
    const getAllProcesses = vi.fn()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(NATIVE))
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
    await readWindowsProcessTableFresh()
    expect(cimScan).not.toHaveBeenCalled()
  })

  it('does not engage when a present binding fails its read', async () => {
    // A wedged or blocked reader must not silently start forking a shell at the
    // caller's poll rate; only absence is unrecoverable.
    const getAllProcesses = vi.fn()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
    expect(cimScan).not.toHaveBeenCalled()
  })

  it('rejects a scan missing our own pid instead of reporting an idle machine', async () => {
    __setWindowsProcessTreeLoaderForTests(() => null)
    cimScan.mockResolvedValue([{ pid: 200, ppid: 4, name: 'claude.exe', command: 'claude' }])
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
  })

  it('stays off Windows-only: darwin still reports unavailable', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    __setWindowsProcessTreeLoaderForTests(() => null)
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unavailable/)
    expect(cimScan).not.toHaveBeenCalled()
  })
})

describe('wedge cooldown', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    vi.useRealTimers()
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('stops calling the reader after a timeout instead of queueing a callback per tick', async () => {
    // The vendored reader latches a global while a request is in flight and
    // drains its queue only when that request completes. In the wedge this
    // guards against it never does, so every retry would add a closure that is
    // never called. One probe per cooldown bounds that.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {})
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))

    const first = readWindowsProcessTableFresh()
    const firstAssertion = expect(first).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await firstAssertion
    expect(getAllProcesses).toHaveBeenCalledTimes(1)

    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/cooling down/)
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('lets exactly one caller probe when the cooldown expires', async () => {
    // Without claiming the recovery slot before probing, every concurrent
    // caller passes the cooldown check at expiry and each enqueues a callback
    // into the still-latched native queue -- so each cycle leaks another batch
    // rather than bounding it to one probe.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {})
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))

    const wedge = readWindowsProcessTableFresh()
    const wedgeAssertion = expect(wedge).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await wedgeAssertion
    expect(getAllProcesses).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    const attempts = [
      readWindowsProcessTableFresh().catch(() => 'rejected'),
      readWindowsProcessTableFresh().catch(() => 'rejected'),
      readWindowsProcessTableFresh().catch(() => 'rejected')
    ]
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.all(attempts)

    // One recovery probe, not three.
    expect(getAllProcesses).toHaveBeenCalledTimes(2)
  })

  it('clears the deadline when the reader throws synchronously', async () => {
    // An orphaned timer would fire later and wedge a reader that had recovered.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {
      throw new Error('addon exploded')
    })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))

    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/exploded/)
    await vi.advanceTimersByTimeAsync(10_000)

    // The recovered reader must answer, not report a wedge left by a dead timer.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses: (cb: (rows: typeof NATIVE | undefined) => void) => cb(NATIVE)
    }))
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(NATIVE.length)
  })
})

// Why against the real require and not the loader seam: relay hosts have no
// node_modules of ours, so which specifier resolves IS the behaviour. #15749
// passed its suites because every one of them replaced the loader wholesale.
describe('resolving the native reader', () => {
  let platform: PropertyDescriptor | undefined
  const PACKAGE_SPECIFIER = '@vscode/windows-process-tree'
  const ADDON_SPECIFIER = './windows-process-tree.node'

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    __setWindowsProcessTreeRequireForTests()
    __setWindowsProcessTableCimScanForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  function addonReturning(rows: unknown): { getProcessList: ReturnType<typeof vi.fn> } {
    return {
      getProcessList: vi.fn((cb: (r: unknown) => void) => cb(rows))
    }
  }

  it('prefers the npm package where the desktop app installs it', async () => {
    const resolve = vi.fn((specifier: string) => {
      if (specifier === PACKAGE_SPECIFIER) {
        return { ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 }, getAllProcesses }
      }
      throw new Error('should not reach the addon')
    })
    __setWindowsProcessTreeRequireForTests(resolve)
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(2)
    expect(resolve).toHaveBeenCalledWith(PACKAGE_SPECIFIER)
    expect(resolve).not.toHaveBeenCalledWith(ADDON_SPECIFIER)
  })

  it('falls through to the addon staged beside the relay bundle', async () => {
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    const rows = await readWindowsProcessTableFresh()
    expect(rows).toEqual([
      { pid: process.pid, ppid: 0, name: 'vitest.exe', command: '', memoryBytes: undefined },
      {
        pid: 100,
        ppid: 4,
        name: 'orca.exe',
        command: '"C:/a b/orca.exe" --x',
        memoryBytes: 4096
      }
    ])
    expect(isWindowsProcessTableAvailable()).toBe(true)
  })

  it('asks the addon for memory and command line, as the package path does', async () => {
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    await readWindowsProcessTableFresh()
    // Memory | CommandLine. A bare snapshot would silently drop the command
    // line every agent-recognition caller matches on first.
    expect(addon.getProcessList).toHaveBeenCalledWith(expect.any(Function), 3)
  })

  it('reaches the CIM scan when neither the package nor the addon is present', async () => {
    const cimScan = vi
      .fn()
      .mockResolvedValue([
        { pid: process.pid, ppid: 0, name: 'node.exe', command: 'node relay.js' }
      ])
    __setWindowsProcessTableCimScanForTests(cimScan)
    __setWindowsProcessTreeRequireForTests(() => {
      throw new Error('MODULE_NOT_FOUND')
    })
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(1)
    expect(cimScan).toHaveBeenCalledTimes(1)
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })

  it('rejects an addon that loads without the call we need', async () => {
    // An arch mismatch or a truncated upload can still produce a loadable file.
    // Binding to it would reject every read forever; the scan still works.
    const cimScan = vi
      .fn()
      .mockResolvedValue([
        { pid: process.pid, ppid: 0, name: 'node.exe', command: 'node relay.js' }
      ])
    __setWindowsProcessTableCimScanForTests(cimScan)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return { notTheApi: true }
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(1)
    expect(cimScan).toHaveBeenCalledTimes(1)
  })

  it('never probes either specifier off Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const resolve = vi.fn()
    __setWindowsProcessTreeRequireForTests(resolve)
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unavailable/)
    expect(resolve).not.toHaveBeenCalled()
  })
})
