import { WindowsProcessTableTimeoutError } from './windows-process-table-timeout-error'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTreeLoaderForTests,
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests
} from './windows-process-table'

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
})
