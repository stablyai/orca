// Regression guard: bound the volume of full-process-table PowerShell/CIM scans
// driven by Windows agent foreground-process inspection — the Windows analogue of
// issue #6288 (POSIX `ps`).
//
// Drives queryWindowsProcessDescendants across several concurrently-inspecting
// agent panes on the agent-completion cadence (ACTIVE_POLL_INTERVAL_MS = 750ms)
// and counts how many powershell.exe process-table scans actually spawn. Pre-fix
// the call site forked one powershell.exe per pane per tick; with the shared
// snapshot cache the scans collapse to ~one per tick regardless of pane count,
// while each pane still resolves the same descendant set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, powershellScanCount } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  powershellScanCount: { value: 0 }
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

const ACTIVE_POLL_INTERVAL_MS = 750
const PANE_COUNT = 6
const WINDOW_SECONDS = 30
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / ACTIVE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 100 + pane * 1000

// A real CIM query returns the whole system, so one shared snapshot must contain
// every pane's shell + foreground node/codex child. Each pane resolves its own
// descendant from the single scan.
const PROCESS_TABLE_JSON = JSON.stringify(
  Array.from({ length: PANE_COUNT }, (_, pane) => {
    const shell = shellPid(pane)
    return [
      {
        ProcessId: shell,
        ParentProcessId: 99,
        Name: 'cmd.exe',
        CommandLine: 'cmd.exe',
        ExecutablePath: 'C:/Windows/System32/cmd.exe'
      },
      {
        ProcessId: shell + 1,
        ParentProcessId: shell,
        Name: 'node.exe',
        CommandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js',
        ExecutablePath: 'C:/Program Files/nodejs/node.exe'
      }
    ]
  }).flat()
)

function installCountingPowerShellMock(): void {
  execFileMock.mockImplementation((cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    if (cmd === 'powershell.exe') {
      powershellScanCount.value += 1
    }
    callback(null, { stdout: PROCESS_TABLE_JSON, stderr: '' })
  })
}

describe('windows agent foreground inspection powershell-scan volume', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    powershellScanCount.value = 0
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('bounds powershell scans by poll ticks, not by pane count, while resolving every pane', async () => {
    installCountingPowerShellMock()

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
    // Pre-fix this equals totalInspections (one powershell.exe per inspection).
    // With the shared cache, concurrent panes within a tick share one scan and
    // the 500ms TTL forces a fresh scan each new 750ms tick -> ~one per tick.
    expect(powershellScanCount.value).toBeLessThanOrEqual(TICKS + 1)
    expect(powershellScanCount.value).toBeLessThan(totalInspections / 2)
  })

  it('collapses a burst of concurrent panes into a single scan', async () => {
    installCountingPowerShellMock()

    await Promise.all(
      Array.from({ length: PANE_COUNT }, (_, pane) =>
        queryWindowsProcessDescendants(shellPid(pane))
      )
    )

    expect(powershellScanCount.value).toBe(1)
  })
})
