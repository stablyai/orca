import { readFile } from 'node:fs/promises'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { runProcess } from '../../shared/child-process/run-process'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'

/** Start times drift by scheduler granularity and clock reads; compare with a tolerance. */
export const PROCESS_START_TIME_TOLERANCE_MS = 2_000

const PROCESS_START_TIME_TIMEOUT_MS = 5_000

export type ProcessStartIdentity = {
  timeMs: number
  /** Exact host-native identity; Windows uses the creation FILETIME. */
  exactId?: string
}

export function processStartIdentitiesMatch(
  expected: Pick<AgentSessionProcessIdentity, 'processStartTimeMs' | 'processStartTimeId'>,
  observed: Pick<AgentSessionProcessIdentity, 'processStartTimeMs' | 'processStartTimeId'>
): boolean {
  if (expected.processStartTimeMs === null || observed.processStartTimeMs === null) {
    return false
  }
  if (expected.processStartTimeId) {
    return observed.processStartTimeId === expected.processStartTimeId
  }
  return (
    Math.abs(observed.processStartTimeMs - expected.processStartTimeMs) <=
    PROCESS_START_TIME_TOLERANCE_MS
  )
}

async function readLinuxProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const [stat, systemStat] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf-8'),
      readFile('/proc/stat', 'utf-8')
    ])
    // Field 22 is starttime in clock ticks; the comm field can contain spaces, so cut past ") ".
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    const ticks = Number(fields[19])
    const bootTimeSeconds = Number(/^btime\s+(\d+)$/m.exec(systemStat)?.[1])
    if (!Number.isFinite(ticks) || !Number.isFinite(bootTimeSeconds)) {
      return null
    }
    return Math.round(bootTimeSeconds * 1000 + (ticks / 100) * 1000)
  } catch {
    return null
  }
}

async function readDarwinProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'lstart=', '-p', String(pid)],
      timeoutMs: PROCESS_START_TIME_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    const parsed = Date.parse(result.stdout.trim())
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function readDarwinProcessStartTimesMs(
  pids: readonly number[]
): Promise<Map<number, number | null>> {
  const observed = new Map<number, number | null>()
  if (pids.length === 0) {
    return observed
  }
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      timeoutMs: PROCESS_START_TIME_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0) {
      return observed
    }
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) {
        continue
      }
      const pid = Number(match[1])
      const parsed = Date.parse(match[2])
      if (Number.isSafeInteger(pid) && Number.isFinite(parsed)) {
        observed.set(pid, parsed)
      }
    }
  } catch {
    // A missing process table is unknown, never evidence that every owner exited.
  }
  return observed
}

async function readWindowsProcessStartIdentity(pid: number): Promise<ProcessStartIdentity | null> {
  try {
    const row = (await readWindowsProcessTableFresh()).find((candidate) => candidate.pid === pid)
    return row?.creationTimeMs === undefined
      ? null
      : {
          timeMs: row.creationTimeMs,
          ...(row.startTimeId === undefined ? {} : { exactId: row.startTimeId })
        }
  } catch {
    return null
  }
}

export async function readProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<ProcessStartIdentity | null> {
  if (platform === 'win32') {
    return readWindowsProcessStartIdentity(pid)
  }
  const timeMs = await readProcessStartTimeMs(pid, platform)
  return timeMs === null ? null : { timeMs }
}

export async function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | null> {
  if (platform === 'linux') {
    return readLinuxProcessStartTimeMs(pid)
  }
  if (platform === 'darwin') {
    return readDarwinProcessStartTimeMs(pid)
  }
  if (platform === 'win32') {
    return (await readWindowsProcessStartIdentity(pid))?.timeMs ?? null
  }
  return null
}

export async function readProcessStartTimesMs(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, number | null>> {
  const uniquePids = [...new Set(pids)]
  if (platform === 'darwin') {
    const table = await readDarwinProcessStartTimesMs(uniquePids)
    return new Map(uniquePids.map((pid) => [pid, table.get(pid) ?? null]))
  }
  return new Map(
    await Promise.all(
      uniquePids.map(async (pid) => [pid, await readProcessStartTimeMs(pid, platform)] as const)
    )
  )
}
