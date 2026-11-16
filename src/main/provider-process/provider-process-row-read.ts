import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { loadLibprocAddon } from '../../shared/process-observation/darwin/libproc-addon'
import {
  readFreshNativeTable,
  registerNativeRequest,
  isNativeReaderHealthy
} from '../../shared/process-observation/darwin/libproc-native-reads'
import { monotonicNow, DEADLINE_PASSED } from '../../shared/concurrency/deadline-settle-notifier'
import {
  inProcessSliceMs,
  runPsInProcess
} from '../../shared/process-observation/darwin/libproc-process-table'
import { readProviderExecProcessRow } from './provider-exec-process-row'
import {
  parseProcessTable,
  type ProcessTableRow
} from '../pty/process-retirement/pty-process-table-parser'

export const PROCESS_ROW_TIMEOUT_MS = 2_000

/** Linux /proc starts use clock ticks; ps lstart requires second-boundary PID-reuse checks. */
export type ProviderProcessRow = Pick<ProcessTableRow, 'pid' | 'ppid' | 'pgid' | 'startedAt'> & {
  startResolution: 'clock-tick' | 'microsecond' | 'second'
}

/** `null`: no such process. `'unverifiable'`: the read failed, which proves nothing. */
export type ProcessRowRead = ProviderProcessRow | null | 'unverifiable'
export type ProviderProcessRowReader = (
  pid: number,
  resolution?: ProviderProcessRow['startResolution']
) => Promise<ProcessRowRead>

/** Older native readers can omit a PID when inspection fails; only ESRCH proves absence. */
export function providerOwnerPidAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
  return false
}

export function readPosixProcessRow(
  pid: number,
  resolution?: ProviderProcessRow['startResolution'],
  platform: NodeJS.Platform = process.platform
): Promise<ProcessRowRead> {
  if (platform === 'linux') {
    return !resolution || resolution === 'clock-tick'
      ? readLinuxProcStatRow(pid)
      : Promise.resolve('unverifiable')
  }
  if (platform === 'win32' || resolution === 'clock-tick') {
    return Promise.resolve('unverifiable')
  }
  return resolution === 'second'
    ? readPsProcessRow(pid)
    : readDarwinProcessRow(pid, resolution === 'microsecond')
}

/** Parses /proc/<pid>/stat; the comm field can hold spaces and parentheses, so cut past ") ". */
export function parseLinuxProcStat(pid: number, stat: string): ProviderProcessRow | null {
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const ticks = fields[19]
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !/^\d+$/.test(ticks ?? '')) {
    return null
  }
  return { pid, ppid, pgid, startedAt: `clock-tick:${ticks}`, startResolution: 'clock-tick' }
}

async function readLinuxProcStatRow(pid: number): Promise<ProcessRowRead> {
  try {
    return parseLinuxProcStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8')) ?? 'unverifiable'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? null
      : 'unverifiable'
  }
}

async function readDarwinProcessRow(pid: number, preciseOnly: boolean): Promise<ProcessRowRead> {
  const deadline = monotonicNow() + PROCESS_ROW_TIMEOUT_MS
  const addon = loadLibprocAddon()
  if (addon && isNativeReaderHealthy()) {
    try {
      const rows = await readFreshNativeTable(
        addon,
        { command: false, pids: [pid] },
        registerNativeRequest(),
        preciseOnly ? monotonicNow() + inProcessSliceMs(PROCESS_ROW_TIMEOUT_MS) : deadline
      )
      if (rows !== DEADLINE_PASSED && rows !== 'stalled' && rows !== null) {
        const row = rows.find((entry) => entry.pid === pid)
        if (!row && (!preciseOnly || providerOwnerPidAbsent(pid))) {
          return null
        }
        if (row?.startUsec !== undefined) {
          return {
            pid,
            ppid: row.ppid,
            pgid: row.pgid,
            startedAt: `microsecond:${row.startSec}:${row.startUsec}`,
            startResolution: 'microsecond'
          }
        }
      }
    } catch {
      // Older native readers still have the bounded ps fallback.
    }
  }
  return preciseOnly ? readProviderExecProcessRow(pid, deadline) : readPsProcessRow(pid)
}

async function readPsProcessRow(pid: number): Promise<ProcessRowRead> {
  try {
    const args = ['-o', 'pid=,ppid=,pgid=,lstart=', '-p', String(pid)]
    // Stable locale makes repeated start markers comparable.
    const env = { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' }
    const result =
      (await runPsInProcess(args, {
        env,
        timeoutMs: PROCESS_ROW_TIMEOUT_MS,
        maxOutputBytes: 4096
      })) ??
      (await runProcess({
        program: 'ps',
        args,
        env,
        timeoutMs: PROCESS_ROW_TIMEOUT_MS,
        maxOutputBytes: 4096
      }))
    const row = parseProcessTable(result.stdout).find((entry) => entry.pid === pid)
    if (row) {
      const startedAtMs = Date.parse(`${row.startedAt} UTC`)
      return Number.isFinite(startedAtMs)
        ? { ...row, startedAt: new Date(startedAtMs).toISOString(), startResolution: 'second' }
        : 'unverifiable'
    }
    // ps exits 1 with no rows for a pid that does not exist; anything else is a failed read.
    return !result.timedOut && result.code === 1 ? null : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
