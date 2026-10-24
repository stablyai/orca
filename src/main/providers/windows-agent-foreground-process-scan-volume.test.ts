// At the 750ms completion cadence, Windows panes must share Toolhelp snapshots and retain per-pane descendants (#6288).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAllProcessesMock = vi.fn()

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { queryWindowsProcessDescendants } from './windows-foreground-process-rows'
// Empty Toolhelp snapshots can mean denial; include the querying process to prove readability.
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

// One system snapshot must include every pane and its descendants.
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
      for (let pane = 0; pane < PANE_COUNT; pane++) {
        const candidates = resolved[pane]
        expect(candidates).not.toBeNull()
        expect(candidates).toHaveLength(1)
        expect(candidates?.[0]?.pid).toBe(shellPid(pane) + 1)
      }
    }

    const totalInspections = PANE_COUNT * TICKS
    // The 500ms TTL expires each 750ms tick; concurrent panes still share a snapshot.
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
