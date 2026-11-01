import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { WindowsProcessTableTimeoutError } from './windows-process-table-timeout-error'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTableCimScanForTests,
  __setWindowsProcessTreeLoaderForTests,
  __setWindowsProcessTreeRequireForTests,
  isWindowsProcessTableAvailable,
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessIdentityTable,
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests,
  type WindowsProcessIdentityRow,
  type WindowsProcessRow
} from './windows-process-table'
import { resetWindowsCommandLineRecoveryHealthForTests } from './windows-command-line-recovery-health'

/** None | CreationTime, and CommandLine on top of it. Memory (1) is never asked for. */
const IDENTITY_FLAGS = 4
const DETAILED_FLAGS = 6

const getAllProcesses = vi.fn()

// Honest snapshots contain self; self also permits command-line queries, unlike protected processes.
type NativeRow = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
  creationTimeMs?: number
}

const SELF: NativeRow = {
  pid: process.pid,
  ppid: 0,
  name: 'vitest.exe',
  commandLine: 'vitest.exe --run'
}
const NATIVE: NativeRow[] = [
  SELF,
  {
    pid: 100,
    ppid: 4,
    name: 'orca.exe',
    commandLine: '"C:/a b/orca.exe" --x',
    creationTimeMs: 1_700_000_000_000
  }
]

/** Model the asynchronous wrapper: overlapping callers lose their flags and receive the first read's rows. */
let coalescingCalls: { flags: number }[] = []
let maxConcurrentNativeCalls = 0

function coalescingModule(): {
  ProcessDataFlag: { None: number; Memory: number; CommandLine: number; CreationTime: number }
  getAllProcesses: (cb: (rows: NativeRow[] | undefined) => void, flags?: number) => void
} {
  let requestInProgress = false
  const queue: ((rows: NativeRow[]) => void)[] = []
  return {
    ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
    getAllProcesses: (cb, flags) => {
      queue.push(cb)
      if (requestInProgress) {
        return
      }
      requestInProgress = true
      coalescingCalls.push({ flags: flags ?? 0 })
      // Gate each field on its own bit so identity creation-time omissions differ from coalesced flag errors.
      const requested = flags ?? 0
      const rows: NativeRow[] = NATIVE.map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        name: row.name,
        ...(requested & 2 && row.commandLine !== undefined ? { commandLine: row.commandLine } : {}),
        ...(requested & 4 && row.creationTimeMs !== undefined
          ? { creationTimeMs: row.creationTimeMs }
          : {})
      }))
      setTimeout(() => {
        while (queue.length) {
          queue.splice(0).forEach((callback) => callback(rows))
        }
        requestInProgress = false
      }, 0)
    }
  }
}

/** Share the mock's module-global latch across reads. */
function installCoalescingModule(): void {
  const native = coalescingModule()
  __setWindowsProcessTreeLoaderForTests(() => native)
}

/** Bare addon exposes overlap directly; the coalescing mock hides concurrent callers behind its own latch. */
function installBareAddonModule(): void {
  let inFlight = 0
  const native = {
    ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
    getAllProcesses: (cb: (rows: NativeRow[] | undefined) => void, flags?: number) => {
      coalescingCalls.push({ flags: flags ?? 0 })
      inFlight += 1
      maxConcurrentNativeCalls = Math.max(maxConcurrentNativeCalls, inFlight)
      setTimeout(() => {
        inFlight -= 1
        cb(NATIVE)
      }, 0)
    }
  }
  __setWindowsProcessTreeLoaderForTests(() => native)
}

describe('windows process table', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    coalescingCalls = []
    maxConcurrentNativeCalls = 0
    getAllProcesses.mockReset()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(NATIVE))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      supportedProcessDataFlags: 7,
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
      { pid: process.pid, ppid: 0, name: 'vitest.exe', command: 'vitest.exe --run' },
      {
        pid: 100,
        ppid: 4,
        name: 'orca.exe',
        command: '"C:/a b/orca.exe" --x',
        creationTimeMs: 1_700_000_000_000
      }
    ])
  })

  it('asks for the command line but never for memory', async () => {
    // No caller needs Memory, which adds a VM_READ handle per process.
    await readWindowsProcessTableFresh()
    expect(getAllProcesses.mock.calls[0]?.[1]).toBe(DETAILED_FLAGS)
  })

  it('reads the identity table with no per-process handle flag at all', async () => {
    await readWindowsProcessIdentityTableFresh()
    expect(getAllProcesses.mock.calls[0]?.[1]).toBe(IDENTITY_FLAGS)
  })

  it('drops the command line from identity rows rather than leaving it empty', async () => {
    const rows = await readWindowsProcessIdentityTableFresh()
    expect(rows).toEqual([
      { pid: process.pid, ppid: 0, name: 'vitest.exe' },
      { pid: 100, ppid: 4, name: 'orca.exe', creationTimeMs: 1_700_000_000_000 }
    ])
    expect(rows.every((row) => !('command' in row))).toBe(true)
  })

  it('collapses a 32-wide burst into one scan per flag set', async () => {
    installCoalescingModule()
    const [identity, detailed] = await Promise.all([
      Promise.all(Array.from({ length: 16 }, () => readWindowsProcessIdentityTable())),
      Promise.all(Array.from({ length: 16 }, () => readWindowsProcessTable()))
    ])
    expect(coalescingCalls.map((call) => call.flags).sort()).toEqual([
      IDENTITY_FLAGS,
      DETAILED_FLAGS
    ])
    expect(identity).toHaveLength(16)
    expect(detailed).toHaveLength(16)
  })

  // The wrapper discards overlapping flags; identity-first used to strip detailed command lines.
  async function expectEachViewGotItsOwnFlags(
    identity: Promise<WindowsProcessIdentityRow[]>,
    detailed: Promise<WindowsProcessRow[]>
  ): Promise<void> {
    const [identityRows, detailedRows] = await Promise.all([identity, detailed])
    expect(detailedRows.some((row) => row.command === '"C:/a b/orca.exe" --x')).toBe(true)
    expect(identityRows.every((row) => !('command' in row))).toBe(true)
    // Verify both row shape and requested flags: either alone misses the other failure mode.
    expect(identityRows.map((row) => row.creationTimeMs)).toEqual([undefined, 1_700_000_000_000])
    expect(detailedRows.map((row) => row.creationTimeMs)).toEqual([undefined, 1_700_000_000_000])
    // This coalescing mock serializes itself; measure our gate against the bare addon separately.
    expect(coalescingCalls.map((call) => call.flags).sort()).toEqual([
      IDENTITY_FLAGS,
      DETAILED_FLAGS
    ])
  }

  it('gives each flag set its own data when the identity read is issued first', async () => {
    installCoalescingModule()
    const identity = readWindowsProcessIdentityTableFresh()
    const detailed = readWindowsProcessTableFresh()
    await expectEachViewGotItsOwnFlags(identity, detailed)
  })

  it('gives each flag set its own data when the detailed read is issued first', async () => {
    installCoalescingModule()
    const detailed = readWindowsProcessTableFresh()
    const identity = readWindowsProcessIdentityTableFresh()
    await expectEachViewGotItsOwnFlags(identity, detailed)
  })

  /** Microtasks only: the mocks call back on a timer, so nothing completes. */
  async function parkPendingReadsOnTheGate(): Promise<void> {
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve()
    }
  }

  it('never re-enters the bare relay addon when both flag sets overlap', async () => {
    installBareAddonModule()
    const detailed = readWindowsProcessTableFresh()
    const identity = readWindowsProcessIdentityTableFresh()
    await Promise.all([detailed, identity])
    expect(coalescingCalls.map((call) => call.flags).sort()).toEqual([
      IDENTITY_FLAGS,
      DETAILED_FLAGS
    ])
    expect(maxConcurrentNativeCalls).toBe(1)
  })

  it('keeps one read in flight across a test reset', async () => {
    // Replacing the gate lets old-chain waiters overlap reads queued on its replacement.
    installBareAddonModule()
    const inFlight = readWindowsProcessTableFresh()
    const waiter = readWindowsProcessIdentityTableFresh()
    await parkPendingReadsOnTheGate()
    resetWindowsProcessTableForTests()
    const afterReset = readWindowsProcessTableFresh()

    await Promise.allSettled([inFlight, waiter, afterReset])
    expect(maxConcurrentNativeCalls).toBe(1)
  })

  it('does not serve one flag set from the other cache', async () => {
    await readWindowsProcessTable()
    await readWindowsProcessIdentityTable()
    expect(getAllProcesses).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty identity snapshot rather than reporting an idle machine', async () => {
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessIdentityTableFresh()).rejects.toThrow(/unreadable/)
  })

  it('applies the deadline to the identity read too', async () => {
    vi.useFakeTimers()
    getAllProcesses.mockImplementation(() => {})
    resetWindowsProcessTableForTests()
    const pending = readWindowsProcessIdentityTableFresh()
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
    vi.useRealTimers()
  })

  it('shares the wedge gate across flag sets, because they share one addon', async () => {
    // Both flags share one wedged addon; separate gates would accumulate retained callbacks.
    vi.useFakeTimers()
    getAllProcesses.mockImplementation(() => {})
    resetWindowsProcessTableForTests()
    const wedge = readWindowsProcessIdentityTableFresh()
    const wedgeAssertion = expect(wedge).rejects.toBeInstanceOf(WindowsProcessTableTimeoutError)
    await vi.advanceTimersByTimeAsync(3_000)
    await wedgeAssertion

    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/wedged/)
    // Timeouts remain distinguishable from unreadable evidence.
    await expect(readWindowsProcessIdentityTableFresh()).rejects.toBeInstanceOf(
      WindowsProcessTableTimeoutError
    )
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('only advertises PID-safe ownership when the BINARY reports creation-time support', () => {
    expect(isWindowsProcessStartTimeAvailable()).toBe(true)

    // Patched JS can advertise CreationTime over a prebuilt that still ignores flag4.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      supportedProcessDataFlags: 3,
      getAllProcesses
    }))
    expect(isWindowsProcessStartTimeAvailable()).toBe(false)

    // Older binaries lack the capability export entirely.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses
    }))
    expect(isWindowsProcessStartTimeAvailable()).toBe(false)
  })

  it('serves repeat reads from the shared snapshot', async () => {
    await readWindowsProcessTable()
    await readWindowsProcessTable()
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('rejects rather than reporting an empty machine when the module is absent', async () => {
    // Absent or failed readers cannot claim no processes are running.
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
    // A blocked snapshot can return [] without error; it must not prove a live root dead.
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
  })

  it('rejects when the snapshot never calls back', async () => {
    // A missing callback must not strand process queries forever.
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

// Relays without a staged addon need fallback; failed evidence otherwise leaves agent names stale.
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

  it('serves the identity view from the one scan a relay can afford', async () => {
    // Share the expensive CIM scan between views.
    __setWindowsProcessTreeLoaderForTests(() => null)
    // Strip command lines even on fallback so identity callers cannot depend on them.
    await expect(readWindowsProcessIdentityTableFresh()).resolves.toEqual([
      { pid: process.pid, ppid: 0, name: 'node.exe' },
      { pid: 200, ppid: process.pid, name: 'claude.exe' }
    ])
    await readWindowsProcessTable()
    expect(cimScan).toHaveBeenCalledTimes(1)
  })

  it('rejects an identity read that omits our own pid', async () => {
    __setWindowsProcessTreeLoaderForTests(() => null)
    cimScan.mockResolvedValue([{ pid: 200, ppid: 4, name: 'claude.exe', command: 'claude' }])
    await expect(readWindowsProcessIdentityTableFresh()).rejects.toThrow(/unreadable/)
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
    // Native failure must not start PowerShell at polling cadence.
    const getAllProcesses = vi.fn()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
    expect(cimScan).not.toHaveBeenCalled()
  })

  it('says so in the log, once, rather than falling back silently', async () => {
    // Legitimate relay fallback must still emit a capability warning (#16905).
    const fallbackWarnings = (): number =>
      warn.mock.calls.filter((call) =>
        String(call[0]).includes('falling back to a powershell.exe CIM scan')
      ).length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    __setWindowsProcessTreeLoaderForTests(() => null)

    await readWindowsProcessTableFresh()
    await readWindowsProcessTableFresh()
    expect(fallbackWarnings()).toBe(1)

    // Reinjection models a fresh process and must restore its once-only warning.
    __setWindowsProcessTreeLoaderForTests(() => null)
    await readWindowsProcessTableFresh()
    expect(fallbackWarnings()).toBe(2)
    warn.mockRestore()
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

describe('sticky wedge', () => {
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
    // A wedged wrapper retains callbacks forever unless re-entry is refused.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {})
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses
    }))

    const first = readWindowsProcessTableFresh()
    const firstAssertion = expect(first).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await firstAssertion
    expect(getAllProcesses).toHaveBeenCalledTimes(1)

    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/wedged/)
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('never re-enters the reader while the timed-out read is still out', async () => {
    // Cooldowns limit callback rate, not retention; only the outstanding callback can reopen the gate.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {})
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses
    }))

    const wedge = readWindowsProcessTableFresh()
    const wedgeAssertion = expect(wedge).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await wedgeAssertion
    expect(getAllProcesses).toHaveBeenCalledTimes(1)

    // Concurrent retries across four old cooldown windows must retain exactly one callback.
    for (let window = 0; window < 4; window += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      const attempts = [
        readWindowsProcessTableFresh().catch(() => 'rejected'),
        readWindowsProcessTableFresh().catch(() => 'rejected'),
        readWindowsProcessTableFresh().catch(() => 'rejected')
      ]
      // Let any accidentally admitted probe reach its own deadline.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await Promise.all(attempts)).toEqual(['rejected', 'rejected', 'rejected'])
    }

    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('resumes as soon as the timed-out read finally calls back', async () => {
    // Only completion of the stuck request proves the queue drained; recovery needs no further cooldown.
    vi.useFakeTimers()
    let stuck: ((rows: typeof NATIVE | undefined) => void) | undefined
    const getAllProcesses = vi.fn((cb: (rows: typeof NATIVE | undefined) => void) => {
      if (stuck) {
        cb(NATIVE)
        return
      }
      stuck = cb
    })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))

    const wedge = readWindowsProcessTableFresh()
    const wedgeAssertion = expect(wedge).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await wedgeAssertion
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/wedged/)

    stuck?.(NATIVE)
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(NATIVE.length)
    expect(getAllProcesses).toHaveBeenCalledTimes(2)
  })

  it('ignores a pending timeout from before a test reset', async () => {
    vi.useFakeTimers()
    const getAllProcesses = vi.fn((_cb: (rows: typeof NATIVE | undefined) => void) => {})
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))

    const staleRead = readWindowsProcessTableFresh()
    const staleAssertion = expect(staleRead).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(0)
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
    resetWindowsProcessTableForTests()
    await vi.advanceTimersByTimeAsync(3_000)
    await staleAssertion

    getAllProcesses.mockImplementation((cb) => cb(NATIVE))
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(NATIVE.length)
    expect(getAllProcesses).toHaveBeenCalledTimes(2)
  })

  it('clears the deadline when the reader throws synchronously', async () => {
    // An uncleared timer can wedge a reader after a synchronous throw already recovered.
    vi.useFakeTimers()
    const getAllProcesses = vi.fn(() => {
      throw new Error('addon exploded')
    })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses
    }))

    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/exploded/)
    await vi.advanceTimersByTimeAsync(10_000)

    // Recovery must not inherit the old deadline's wedge.
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: (cb: (rows: typeof NATIVE | undefined) => void) => cb(NATIVE)
    }))
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(NATIVE.length)
  })
})

// Exercise real require resolution: replacing the loader hid missing relay specifiers (#15749).
describe('resolving the native reader', () => {
  let platform: PropertyDescriptor | undefined
  const PACKAGE_SPECIFIER = '@vscode/windows-process-tree'
  const ADDON_SPECIFIER = './windows-process-tree.node'
  const stagedAddonDirs: string[] = []

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    __setWindowsProcessTreeRequireForTests()
    __setWindowsProcessTableCimScanForTests()
    for (const dir of stagedAddonDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  function addonReturning(rows: unknown): {
    getProcessList: ReturnType<typeof vi.fn>
    supportedProcessDataFlags: number
  } {
    return {
      getProcessList: vi.fn((cb: (r: unknown) => void) => cb(rows)),
      supportedProcessDataFlags: 7
    }
  }

  /** Older binaries have no creation-time capability export. */
  function staleAddonReturning(rows: unknown): { getProcessList: ReturnType<typeof vi.fn> } {
    return { getProcessList: vi.fn((cb: (r: unknown) => void) => cb(rows)) }
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
      { pid: process.pid, ppid: 0, name: 'vitest.exe', command: 'vitest.exe --run' },
      {
        pid: 100,
        ppid: 4,
        name: 'orca.exe',
        command: '"C:/a b/orca.exe" --x',
        creationTimeMs: 1_700_000_000_000
      }
    ])
    expect(isWindowsProcessTableAvailable()).toBe(true)
  })

  it('asks the addon for the command line and creation time, as the package path does', async () => {
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    await readWindowsProcessTableFresh()
    // Detailed reads need creation times for PID-safe teardown and omit unused Memory.
    expect(addon.getProcessList).toHaveBeenCalledWith(expect.any(Function), 6)
    expect(isWindowsProcessStartTimeAvailable()).toBe(true)
  })

  it('asks the addon for the creation time alone on the identity path', async () => {
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    await readWindowsProcessIdentityTableFresh()
    // CreationTime alone uses a limited handle/GetProcessTimes; no command-line query.
    expect(addon.getProcessList).toHaveBeenCalledWith(expect.any(Function), 4)
  })

  it('trusts the staged addon on its own report, not on ours', async () => {
    // Old addons still enumerate but cannot prove PID incarnation without creation times.
    const addon = staleAddonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests((specifier: string) => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    })
    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(2)
    expect(isWindowsProcessTableAvailable()).toBe(true)
    expect(isWindowsProcessStartTimeAvailable()).toBe(false)
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
    // Unusable addon shapes must fall back rather than reject every subsequent read.
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

  // Independent deployment can leave a loadable old addon that still imports ReadProcessMemory.
  function withStagedAddonBinary(
    bytes: string,
    addon: unknown
  ): ((specifier: string) => unknown) & { resolve: (specifier: string) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-relay-addon-'))
    const addonPath = join(dir, 'windows-process-tree.node')
    writeFileSync(addonPath, bytes)
    stagedAddonDirs.push(dir)
    const resolve = (specifier: string): unknown => {
      if (specifier === ADDON_SPECIFIER) {
        return addon
      }
      throw new Error('MODULE_NOT_FOUND')
    }
    resolve.resolve = (specifier: string): string => {
      if (specifier === ADDON_SPECIFIER) {
        return addonPath
      }
      throw new Error('MODULE_NOT_FOUND')
    }
    return resolve
  }

  it('refuses a staged relay addon still built from unpatched source', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cimScan = vi
      .fn()
      .mockResolvedValue([
        { pid: process.pid, ppid: 0, name: 'node.exe', command: 'node relay.js' }
      ])
    __setWindowsProcessTableCimScanForTests(cimScan)
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests(
      withStagedAddonBinary('MZ\0KERNEL32.dll\0ReadProcessMemory\0', addon)
    )

    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(1)
    expect(addon.getProcessList).not.toHaveBeenCalled()
    expect(cimScan).toHaveBeenCalledTimes(1)
    expect(isWindowsProcessTableAvailable()).toBe(false)
    expect(warn.mock.calls[0]?.[0]).toContain('ReadProcessMemory')
    warn.mockRestore()
  })

  it('binds a staged relay addon whose binary carries no such import', async () => {
    const addon = addonReturning(NATIVE)
    __setWindowsProcessTreeRequireForTests(
      withStagedAddonBinary('MZ\0ntdll.dll\0NtQueryInformationProcess\0', addon)
    )

    await expect(readWindowsProcessTableFresh()).resolves.toHaveLength(2)
    expect(addon.getProcessList).toHaveBeenCalledTimes(1)
  })

  it('never probes either specifier off Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const resolve = vi.fn()
    __setWindowsProcessTreeRequireForTests(resolve)
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unavailable/)
    expect(resolve).not.toHaveBeenCalled()
  })
})

// Kernel command-line refusal leaves enumeration healthy; capability checks alone miss it.
describe('warning when command-line recovery is refused host-wide', () => {
  let platform: PropertyDescriptor | undefined
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetWindowsCommandLineRecoveryHealthForTests()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    warn.mockRestore()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  type NativeRow = { pid: number; ppid: number; name: string; commandLine?: string }

  function loaderReturning(rows: NativeRow[], commandLineFlag: number): void {
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: commandLineFlag, CreationTime: 4 },
      getAllProcesses: (cb: (r: NativeRow[] | undefined) => void) => cb(rows)
    }))
  }

  it('warns once when our own row comes back with no command line', async () => {
    loaderReturning([{ pid: process.pid, ppid: 0, name: 'vitest.exe' }], 2)
    await readWindowsProcessTableFresh()
    await readWindowsProcessTableFresh()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('ProcessCommandLineInformation')
  })

  it('stays quiet when our own command line came back', async () => {
    loaderReturning(NATIVE, 2)
    await readWindowsProcessTableFresh()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet when the read never asked for a command line', async () => {
    // A reader that requests identity fields only must not read as a refusal.
    loaderReturning([{ pid: process.pid, ppid: 0, name: 'vitest.exe' }], 0)
    await readWindowsProcessTableFresh()
    expect(warn).not.toHaveBeenCalled()
  })
})
