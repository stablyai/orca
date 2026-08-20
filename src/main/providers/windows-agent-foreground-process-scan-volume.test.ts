// Regression guard: bound the volume of full-process-table scans driven by
// Windows agent foreground-process inspection — the Windows analogue of issue
// #6288 (POSIX `ps`).
//
// Drives queryWindowsProcessDescendants across several concurrently-inspecting
// agent panes on the agent-completion cadence (ACTIVE_POLL_INTERVAL_MS = 750ms)
// and counts the process-table scans that actually spawn. Pre-fix the call site
// forked one per pane per tick; with the shared snapshot cache they collapse to
// ~one per tick regardless of pane count, while each pane still resolves the same
// descendant set. Counted per command, because #15209 turns on which binary runs:
// over this window a wmic-capable host must fork no PowerShell host at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, scanCounts } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  scanCounts: { powershell: 0, wmic: 0 }
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsReaderForTests
} from './windows-foreground-process-rows'

const ACTIVE_POLL_INTERVAL_MS = 750
const PANE_COUNT = 6
const WINDOW_SECONDS = 30
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / ACTIVE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 100 + pane * 1000

// A real CIM query returns the whole system, so one shared snapshot must contain
// every pane's shell + foreground node/codex child. Each pane resolves its own
// descendant from the single scan.
const PROCESS_ROWS = Array.from({ length: PANE_COUNT }, (_, pane) => {
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

const PROCESS_TABLE_JSON = JSON.stringify(PROCESS_ROWS)

/** wmic /format:value: one `Key=Value` line per property, records blank-separated. */
const PROCESS_TABLE_VALUE = PROCESS_ROWS.map((row) =>
  [
    `CommandLine=${row.CommandLine}`,
    `ExecutablePath=${row.ExecutablePath}`,
    `Name=${row.Name}`,
    `ParentProcessId=${row.ParentProcessId}`,
    `ProcessId=${row.ProcessId}`
  ].join('\r\n')
).join('\r\n\r\n')

function installCountingScanMock(): void {
  execFileMock.mockImplementation((cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    if (/wmic/i.test(cmd)) {
      scanCounts.wmic += 1
      callback(null, { stdout: PROCESS_TABLE_VALUE, stderr: '' })
      return
    }
    scanCounts.powershell += 1
    callback(null, { stdout: PROCESS_TABLE_JSON, stderr: '' })
  })
}

describe('windows agent foreground inspection process-table scan volume', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsReaderForTests()
    scanCounts.powershell = 0
    scanCounts.wmic = 0
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

  it('bounds scans by poll ticks, not by pane count, while resolving every pane', async () => {
    installCountingScanMock()

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
    expect(scanCounts.wmic).toBeLessThanOrEqual(TICKS + 1)
    expect(scanCounts.wmic).toBeLessThan(totalInspections / 2)
    // #15209: every one of these would have been a transcript file under the
    // enterprise PowerShell transcription GPO.
    expect(scanCounts.powershell).toBe(0)
  })

  it('collapses a burst of concurrent panes into a single scan', async () => {
    installCountingScanMock()

    await Promise.all(
      Array.from({ length: PANE_COUNT }, (_, pane) =>
        queryWindowsProcessDescendants(shellPid(pane))
      )
    )

    expect(scanCounts.wmic).toBe(1)
  })
})
