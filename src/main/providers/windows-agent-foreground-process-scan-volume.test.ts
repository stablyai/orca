// Regression guard: bound the volume of full-process-table scans driven by
// Windows agent foreground-process inspection — the Windows analogue of issue
// #6288 (POSIX `ps`).
//
// Drives queryWindowsProcessDescendants across several concurrently-inspecting
// agent panes on the agent-completion cadence (ACTIVE_POLL_INTERVAL_MS = 750ms)
// and counts how many Toolhelp32 snapshots actually run. Pre-fix the call site
// scanned once per pane per tick; with the shared snapshot cache the scans
// collapse to ~one per tick regardless of pane count, while each pane still
// resolves the same descendant set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { queryWindowsProcessDescendants } from './windows-foreground-process-rows'
// A real snapshot always contains the process doing the querying; the reader
// rejects a table without it, because that is what a blocked
// CreateToolhelp32Snapshot looks like (an empty list, not an error).
const SELF_PROCESS_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }
const withSelf = <T>(rows: readonly T[]): (T | typeof SELF_PROCESS_ROW)[] => [
  SELF_PROCESS_ROW,
  ...rows
]

const ACTIVE_POLL_INTERVAL_MS = 750
const PANE_COUNT = 6
const WINDOW_SECONDS = 30
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / ACTIVE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 100 + pane * 1000

// A snapshot returns the whole system, so one shared scan must contain every
// pane's shell + foreground node/codex child. Each pane resolves its own
// descendant from the single scan.
const NATIVE_ROWS = Array.from({ length: PANE_COUNT }, (_, pane) => {
  const shell = shellPid(pane)
  return [
    {
      pid: shell,
      ppid: 99,
      name: 'cmd.exe',
      commandLine: 'cmd.exe'
    },
    {
      pid: shell + 1,
      ppid: shell,
      name: 'node.exe',
      commandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js'
    }
  ]
}).flat()

describe('windows agent foreground inspection process-table scan volume', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcessesMock.mockReset()
    getAllProcessesMock.mockImplementation((cb: (snapshot: unknown) => void) => {
      cb(withSelf(NATIVE_ROWS))
    })
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: getAllProcessesMock
    }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  const scanCount = (): number => getAllProcessesMock.mock.calls.length

  it('bounds process-table scans by poll ticks, not by pane count, while resolving every pane', async () => {
    for (let tick = 0; tick < TICKS; tick++) {
      vi.setSystemTime(tick * ACTIVE_POLL_INTERVAL_MS)
      // All panes inspect concurrently within the tick (worst case).
      const resolved = await Promise.all(
        Array.from({ length: PANE_COUNT }, (_, pane) =>
          queryWindowsProcessDescendants(shellPid(pane))
        )
      )
      // Caching must not change the answer: every pane still finds its foreground
      // node child as the sole descendant of its shell.
      for (let pane = 0; pane < PANE_COUNT; pane++) {
        const candidates = resolved[pane]
        expect(candidates).not.toBeNull()
        expect(candidates).toHaveLength(1)
        expect(candidates?.[0]?.pid).toBe(shellPid(pane) + 1)
      }
    }

    const totalInspections = PANE_COUNT * TICKS
    // Pre-fix this equals totalInspections (one scan per inspection). With the
    // shared cache, concurrent panes within a tick share one scan and the 500ms
    // TTL forces a fresh scan each new 750ms tick -> ~one per tick.
    expect(scanCount()).toBeLessThanOrEqual(TICKS + 1)
    expect(scanCount()).toBeLessThan(totalInspections / 2)
  })

  it('collapses a burst of concurrent panes into a single scan', async () => {
    await Promise.all(
      Array.from({ length: PANE_COUNT }, (_, pane) =>
        queryWindowsProcessDescendants(shellPid(pane))
      )
    )

    expect(scanCount()).toBe(1)
  })
})
