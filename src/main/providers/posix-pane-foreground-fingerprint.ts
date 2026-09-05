import { readFile } from 'node:fs/promises'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { parseLinuxProcStatStartTime } from '../../shared/process-table-snapshot-reader'

/** The job-control columns both `ps` tiers carry; `command`/`tty` are deliberately absent. */
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

/**
 * Only the job-control bits of `stat`. The scheduler letter (R/S/D/I/U) flips every tick
 * on a working agent and says nothing about whether the pane changed hands; stopped,
 * zombie, and foreground-group membership do.
 */
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

/**
 * A per-pane summary of everything the cheap `ps` tier can see: the root shell's identity
 * (pid + start marker) and terminal foreground group, and every descendant's identity, group,
 * and job-control state. Two captures with equal fingerprints describe the same pane
 * subtree, so the name resolved from the last full capture still holds.
 *
 * Null when the root is missing or unfenced (no start marker, no group columns): callers
 * must then take the full capture rather than trust a comparison that could not be made.
 */
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
  const members = descendants
    .map(
      (row) =>
        `${row.pid}@${startTimes.get(row.pid) ?? '?'}:${row.pgid ?? '?'}:${jobControlState(row.stat)}`
    )
    .sort()
  return `${rootPid}@${rootStart}#${root.tpgid}:${jobControlState(root.stat)}|${members.join(',')}`
}
