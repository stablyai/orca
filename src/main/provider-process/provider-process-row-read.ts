import type { ProviderGroupMember } from './provider-process-group'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import type { ProviderCleanupBudget } from './provider-process-exit-deadline'
import { parseProcessTable, type ProcessTableRow } from '../pty-process-table-parser'

const PROCESS_ROW_TIMEOUT_MS = 2_000

/**
 * One process's parent, group and start marker. `clock-tick` starts come from Linux /proc, where a
 * pid reused within one tick would need the whole pid space to cycle; `second` starts are ps lstart.
 */
export type ProviderProcessRow = Pick<ProcessTableRow, 'pid' | 'ppid' | 'pgid' | 'startedAt'> & {
  startResolution: 'clock-tick' | 'second'
  zombie?: boolean
}

/** `null`: no such process. `'unverifiable'`: the read failed, which proves nothing. */
export type ProcessRowRead = ProviderProcessRow | null | 'unverifiable'

export function readPosixProcessRow(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  budget?: ProviderCleanupBudget
): Promise<ProcessRowRead> {
  if (budget && !budget.active) {
    return Promise.resolve('unverifiable')
  }
  return platform === 'linux' ? readLinuxProcStatRow(pid, budget) : readPsProcessRow(pid, budget)
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
  return {
    pid,
    ppid,
    pgid,
    startedAt: `clock-tick:${ticks}`,
    startResolution: 'clock-tick',
    zombie: fields[0] === 'Z'
  }
}

async function readLinuxProcStatRow(
  pid: number,
  budget?: ProviderCleanupBudget
): Promise<ProcessRowRead> {
  try {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal: budget?.signal }),
      readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal: budget?.signal })
    ])
    const row = parseLinuxProcStat(pid, stat)
    return row && boot.trim()
      ? { ...row, startedAt: `${boot.trim()}:${row.startedAt}` }
      : 'unverifiable'
  } catch (error) {
    return error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      'path' in error &&
      error.path === `/proc/${pid}/stat`
      ? null
      : 'unverifiable'
  }
}

async function readPsProcessRow(
  pid: number,
  budget?: ProviderCleanupBudget
): Promise<ProcessRowRead> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,ppid=,pgid=,lstart=,stat=', '-p', String(pid)],
      // Identity must survive a timezone change between capture and recovery.
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      timeoutMs: Math.min(PROCESS_ROW_TIMEOUT_MS, budget?.remaining() ?? PROCESS_ROW_TIMEOUT_MS),
      signal: budget?.signal,
      maxOutputBytes: 4096
    })
    const row = parseProcessTable(result.stdout.replace(/\s+\S+\s*$/, '')).find(
      (entry) => entry.pid === pid
    )
    if (row) {
      const started = Date.parse(`${row.startedAt} UTC`)
      return Number.isFinite(started)
        ? {
            ...row,
            startedAt: new Date(started).toISOString(),
            startResolution: 'second',
            zombie: /\sZ\S*\s*$/.test(result.stdout)
          }
        : 'unverifiable'
    }
    // ps exits 1 with no rows for a pid that does not exist; anything else is a failed read.
    return !result.timedOut && result.code === 1 ? null : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

export async function readProviderWriterVerdict(
  members: readonly ProviderGroupMember[],
  budget: ProviderCleanupBudget,
  read: typeof readPosixProcessRow
): Promise<'live' | 'unknown' | 'exited'> {
  let unknown = false
  for (const member of members) {
    if (!budget.active) {
      return 'unknown'
    }
    const row = await read(member.pid, process.platform, budget)
    if (
      row === 'unverifiable' ||
      (row && !row.zombie && process.platform === 'darwin' && !member.startedAt.endsWith('Z'))
    ) {
      unknown = true
    } else if (row && !row.zombie && row.startedAt === member.startedAt) {
      return 'live'
    }
  }
  return unknown ? 'unknown' : 'exited'
}

/** A newer observation replaces an object; an older in-flight read cannot delete that evidence. */
export async function pruneProviderMembers(
  members: ProviderGroupMember[],
  budget: ProviderCleanupBudget,
  read: typeof readPosixProcessRow,
  anchor?: number
): Promise<'live' | 'unknown' | 'exited'> {
  const live = new Set<ProviderGroupMember>()
  const anchors = new Set<ProviderGroupMember>()
  const observed = [...members]
  for (const member of observed) {
    const verdict = await readProviderWriterVerdict([member], budget, read)
    if (!budget.active) {
      return 'unknown'
    }
    const index = members.indexOf(member)
    if (index === -1) {
      continue
    }
    if (verdict === 'exited' && member.pid !== anchor) {
      members.splice(index, 1)
    } else {
      const current = { ...member }
      members[index] = current
      if (verdict === 'live') {
        live.add(current)
      }
      if (verdict === 'exited') {
        anchors.add(current)
      }
    }
  }
  return members.some((member) => live.has(member))
    ? 'live'
    : members.every((member) => anchors.has(member))
      ? 'exited'
      : 'unknown'
}

/** A launch owner needs a live, unambiguous identity for this host process. */
export async function readHostRow(
  budget: ProviderCleanupBudget,
  read: typeof readPosixProcessRow
): Promise<ProviderProcessRow | null> {
  const boundary = Date.now()
  const owner = await read(process.pid, process.platform, budget)
  return !owner ||
    owner === 'unverifiable' ||
    owner.zombie ||
    (owner.startResolution === 'second' && !hasUnambiguousStartTime(owner.startedAt, boundary))
    ? null
    : owner
}
