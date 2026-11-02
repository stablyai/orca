// Pin per-pane projection/index work as well as shared snapshot count at measured table/fan-out sizes (#6288).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import {
  queryWindowsPaneProcessInventory,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

// Measured host size and pane fan-out from windows-process-enumeration.md.
const TABLE_SIZE = 1050
const PANE_COUNT = 11

const SELF_ROW = { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' }

const shellPid = (pane: number): number => 10_000 + pane * 10
const agentPid = (pane: number): number => shellPid(pane) + 1
/** Shared row object identity distinguishes reused projection from per-pane copies. */
const PROBE_PID = 900_000 + TABLE_SIZE - 1

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

/** Count index insertions only inside this awaited region; restore the prototype in finally. */
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

  it('projects the shared snapshot once for the whole pane fan-out', async () => {
    const probeRows: unknown[] = []
    for (let pane = 0; pane < PANE_COUNT; pane += 1) {
      const inventory = await queryWindowsPaneProcessInventory(shellPid(pane), {
        anchorPid: PROBE_PID
      })
      probeRows.push(inventory?.anchorRow)
    }
    expect(probeRows.filter(Boolean)).toHaveLength(PANE_COUNT)
    // Every pane must share the projected row object, not allocate its own whole-table copy.
    expect(new Set(probeRows).size).toBe(1)
  })

  it('indexes the shared snapshot once for the whole pane fan-out', async () => {
    // Prime the TTL cache and the index so the snapshot read is not in the count.
    await queryWindowsPaneProcessInventory(shellPid(0), { anchorPid: agentPid(0) })

    const insertions = await countMapInsertions(async () => {
      await sweepPanes()
    })

    // A warm shared index must avoid a whole-table Map rebuild per pane.
    expect(insertions).toBeLessThan(TABLE_SIZE)
  })
})
