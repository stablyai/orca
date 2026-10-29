import { readFile } from 'node:fs/promises'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { parseLinuxProcStatStartTime } from '../../shared/process-table-snapshot-reader'

/** Cheap-tier job-control columns omit command/tty by design. */
export type PaneFingerprintRow = {
  pid: number
  ppid: number
  pgid?: number
  tpgid?: number
  stat: string
  startTime?: string
}

export type PaneFingerprintDeps = {
  platform?: NodeJS.Platform
  /** Linux: `/proc/<pid>/stat` field 22, read for the pane subtree only. */
  readLinuxStartTime?: (pid: number) => Promise<string | null>
}

/** Ignore scheduler churn; stopped, zombie and foreground states can change pane ownership. */
function jobControlState(stat: string): string {
  const head = stat[0] ?? ''
  const lifecycle = head === 'T' || head === 't' ? 'T' : head === 'Z' ? 'Z' : ''
  return lifecycle + (stat.includes('+') ? '+' : '')
}

async function readLinuxProcStartTime(pid: number): Promise<string | null> {
  try {
    return parseLinuxProcStatStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

/** Reuse recognition only across equal fenced shell/descendant identities, groups and job-control state.
 * Missing root, start markers or group columns requires a full capture instead. */
export async function buildPaneProcessFingerprint(
  rows: readonly PaneFingerprintRow[],
  rootPid: number,
  deps: PaneFingerprintDeps = {}
): Promise<string | null> {
  const platform = deps.platform ?? process.platform
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  if (!root || root.pgid === undefined || root.tpgid === undefined) {
    return null
  }
  const descendants = collectDescendantsFromIndex(index, rootPid)
  const subtree = [root, ...descendants]
  let startTimes: ReadonlyMap<number, string | null>
  if (platform === 'linux') {
    const read = deps.readLinuxStartTime ?? readLinuxProcStartTime
    const entries = await Promise.all(
      subtree.map(async (row) => [row.pid, await read(row.pid)] as const)
    )
    startTimes = new Map(entries)
  } else {
    // Collapse `lstart` padding (`Sep  3`) so both column sets stamp identically.
    startTimes = new Map(
      subtree.map((row) => [row.pid, row.startTime?.replace(/\s+/g, ' ') ?? null] as const)
    )
  }
  const rootStart = startTimes.get(rootPid)
  if (!rootStart) {
    return null
  }
  // Every descendant needs a start marker; placeholders could compare equal across PID reuse and mask agent exit.
  const members: string[] = []
  for (const row of descendants) {
    const startTime = startTimes.get(row.pid)
    if (!startTime) {
      return null
    }
    members.push(`${row.pid}@${startTime}:${row.pgid ?? '?'}:${jobControlState(row.stat)}`)
  }
  members.sort()
  return `${rootPid}@${rootStart}#${root.tpgid}:${jobControlState(root.stat)}|${members.join(',')}`
}
