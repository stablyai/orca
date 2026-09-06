// Regression guard on the per-inspection cost of Windows agent foreground
// inspection — the Windows analogue of the POSIX index memo (#6288).
//
// The shared TTL cache already collapses N panes into one Toolhelp32 snapshot
// (windows-agent-foreground-process-scan-volume.test.ts). What it never
// collapsed is the work each pane does ON that snapshot: a full
// `native.map(toProcessRow)` projection, a `childrenByPpid` Map rebuilt from
// scratch, and two linear scans. This file counts that work at a realistic
// table size and pane count, and pins the flag set the snapshot asks for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  queryWindowsPaneProcessInventory,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

// 1050 processes is the host measured in windows-process-enumeration.md; 11
// panes is the fan-out the shared snapshot exists to serve.
const TABLE_SIZE = 1050
const PANE_COUNT = 11

const SELF_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }

const shellPid = (pane: number): number => 10_000 + pane * 10
const agentPid = (pane: number): number => shellPid(pane) + 1
/** A row every pane can look up, so distinct results == distinct projections. */
const PROBE_PID = 900_000 + TABLE_SIZE - 1

/** One shell + one agent child per pane, padded out to a real table size. */
function buildNativeTable(): { pid: number; ppid: number; name: string; commandLine: string }[] {
  const rows = [SELF_ROW]
  for (let pane = 0; pane < PANE_COUNT; pane += 1) {
    rows.push({ pid: shellPid(pane), ppid: 4, name: 'cmd.exe', commandLine: 'cmd.exe' })
    rows.push({
      pid: agentPid(pane),
      ppid: shellPid(pane),
      name: 'node.exe',
      commandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js'
    })
  }
  for (let filler = rows.length; filler < TABLE_SIZE; filler += 1) {
    rows.push({ pid: 900_000 + filler, ppid: 4, name: 'svchost.exe', commandLine: 'svchost.exe' })
  }
  return rows
}

const NATIVE_TABLE = buildNativeTable()

/**
 * Count `Map.prototype.set` calls — the primitive both the old per-call
 * `childrenByPpid` rebuild and the shared index build are made of. Patched for
 * one awaited region and restored in `finally`, so nothing else observes it.
 */
async function countMapInsertions(run: () => Promise<void>): Promise<number> {
  const original = Map.prototype.set
  let insertions = 0
  Map.prototype.set = function patched(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    insertions += 1
    return original.call(this, key, value)
  } as typeof Map.prototype.set
  try {
    await run()
  } finally {
    Map.prototype.set = original
  }
  return insertions
}

describe('windows foreground inspection cost per pane', () => {
  const getAllProcesses = vi.fn()
  let platform: PropertyDescriptor | undefined
  let flagsSeen: number[] = []

  beforeEach(() => {
    flagsSeen = []
    getAllProcesses.mockReset()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void, flags: number) => {
      flagsSeen.push(flags)
      cb(NATIVE_TABLE)
    })
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses
    }))
    resetWindowsProcessRowsSnapshotForTests()
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

  async function sweepPanes(): Promise<(number | undefined)[]> {
    const resolved: (number | undefined)[] = []
    for (let pane = 0; pane < PANE_COUNT; pane += 1) {
      const inventory = await queryWindowsPaneProcessInventory(shellPid(pane), {
        anchorPid: agentPid(pane)
      })
      expect(inventory?.candidates).toHaveLength(1)
      resolved.push(inventory?.candidates[0]?.pid)
    }
    return resolved
  }

  it('never sets the Memory flag on the snapshot', async () => {
    await queryWindowsPaneProcessInventory(shellPid(0))
    expect(flagsSeen).toHaveLength(1)
    // Memory is bit 0, and it costs the addon a second OpenProcess per process
    // carrying PROCESS_VM_READ (process.cc `GetProcessMemoryUsage`).
    expect(flagsSeen[0]! & 1).toBe(0)
    // CommandLine (2) | CreationTime (4).
    expect(flagsSeen[0]).toBe(6)
  })

  it('projects the shared snapshot once for the whole pane fan-out', async () => {
    const probeRows: unknown[] = []
    for (let pane = 0; pane < PANE_COUNT; pane += 1) {
      const inventory = await queryWindowsPaneProcessInventory(shellPid(pane), {
        anchorPid: PROBE_PID
      })
      probeRows.push(inventory?.anchorRow)
    }
    expect(probeRows.filter(Boolean)).toHaveLength(PANE_COUNT)
    // One projection produced every pane's row object. Pre-fix each pane ran
    // its own `native.map(toProcessRow)` over all 1050 rows, so this set held
    // PANE_COUNT distinct objects and the sweep allocated PANE_COUNT * 1050.
    expect(new Set(probeRows).size).toBe(1)
  })

  it('indexes the shared snapshot once for the whole pane fan-out', async () => {
    // Prime the TTL cache and the index so the snapshot read is not in the count.
    await queryWindowsPaneProcessInventory(shellPid(0), { anchorPid: agentPid(0) })

    const insertions = await countMapInsertions(async () => {
      await sweepPanes()
    })

    // Pre-fix every pane rebuilt a whole-table `childrenByPpid`, so this was
    // >= PANE_COUNT * (rows with a distinct ppid). One shared index makes the
    // whole sweep cost no table-sized Map build at all.
    expect(insertions).toBeLessThan(TABLE_SIZE)
  })

  it('resolves the same foreground child for every pane as an unshared scan would', async () => {
    const resolved = await sweepPanes()
    expect(resolved).toEqual(Array.from({ length: PANE_COUNT }, (_, pane) => agentPid(pane)))
  })
})
