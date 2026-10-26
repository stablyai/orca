import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { parseProcessTable, type ProcessTableRow } from '../pty-process-table-parser'

const PROCESS_ROW_TIMEOUT_MS = 2_000

/** Linux /proc starts use clock ticks; ps lstart requires second-boundary PID-reuse checks. */
export type ProviderProcessRow = Pick<ProcessTableRow, 'pid' | 'ppid' | 'pgid' | 'startedAt'> & {
  startResolution: 'clock-tick' | 'second'
}

/** `null`: no such process. `'unverifiable'`: the read failed, which proves nothing. */
export type ProcessRowRead = ProviderProcessRow | null | 'unverifiable'

export function readPosixProcessRow(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<ProcessRowRead> {
  return platform === 'linux' ? readLinuxProcStatRow(pid) : readPsProcessRow(pid)
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

async function readPsProcessRow(pid: number): Promise<ProcessRowRead> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,ppid=,pgid=,lstart=', '-p', String(pid)],
      // Stable locale makes repeated start markers comparable.
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      timeoutMs: PROCESS_ROW_TIMEOUT_MS,
      maxOutputBytes: 4096
    })
    const row = parseProcessTable(result.stdout).find((entry) => entry.pid === pid)
    if (row) {
      return { ...row, startResolution: 'second' }
    }
    // ps exits 1 with no rows for a pid that does not exist; anything else is a failed read.
    return !result.timedOut && result.code === 1 ? null : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
