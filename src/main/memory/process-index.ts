import type { ProcessMemoryMetric } from '../../shared/diagnostics/process-stats-types'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-observation/process-output-field-scanner'

export type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core; may exceed 100 across cores. */
  cpu: number
  /** Bytes in the snapshot's processMemoryMetric (footprint on macOS when available, else RSS/working set). */
  memory: number
  /** Committed bytes, including paged-out memory; absent when unavailable. */
  privateMemory?: number
  /** Executable basename; never a path or command line. */
  name?: string
  /** Creation time in 100 ns ticks (Windows CIM only); orders a parent before its children. */
  startTicks?: bigint
  /** Process group (Unix sweeps without names); ties an orphan to the group it was started in. */
  pgid?: number
}

export type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
  /** Processes init adopted, by the process group they kept; absent without group data. */
  orphansByGroup?: Map<number, number[]>
  /** Missing commit counters must not look like measured zero. */
  hasPrivateMemory: boolean
  memoryMetric: ProcessMemoryMetric
}

/** Index one host process sweep; macOS footprints replace RSS so shared framework pages are not summed per process. */
export function buildProcessIndex(
  rows: ProcRow[],
  footprints: ReadonlyMap<number, number> | null,
  fallbackMetric: ProcessMemoryMetric
): ProcIndex {
  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  const orphansByGroup = new Map<number, number[]>()
  let hasPrivateMemory = false
  for (const row of rows) {
    if (row.ppid === 1 && row.pgid !== undefined && row.pgid !== row.pid) {
      const orphans = orphansByGroup.get(row.pgid)
      if (orphans) {
        orphans.push(row.pid)
      } else {
        orphansByGroup.set(row.pgid, [row.pid])
      }
    }
    const footprint = footprints?.get(row.pid)
    if (footprint !== undefined) {
      row.memory = footprint
    }
    byPid.set(row.pid, row)
    hasPrivateMemory ||= row.privateMemory !== undefined
    const siblings = childrenOf.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      childrenOf.set(row.ppid, [row.pid])
    }
  }
  return {
    byPid,
    childrenOf,
    orphansByGroup,
    hasPrivateMemory,
    memoryMetric: footprints ? 'footprint' : fallbackMetric
  }
}

/** `withGroup` reads a fifth `pgid` column; it never combines with the trailing name column. */
export function parsePsOutput(stdout: string, withName = false, withGroup = false): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = getProcessOutputFields(line, withGroup ? 5 : 4)
    if (fields.length < (withGroup ? 5 : 4)) {
      continue
    }
    const pgid = withGroup ? Number.parseInt(fields[4], 10) : Number.NaN
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const cpu = Number.parseFloat(fields[2])
    const rssKb = Number.parseInt(fields[3], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) {
      continue
    }
    const name = withName ? executableBasename(PS_COMM_COLUMN.exec(line)?.[1]) : undefined
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : 0,
      memory: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      ...(name ? { name } : {}),
      ...(Number.isSafeInteger(pgid) && pgid > 0 ? { pgid } : {})
    })
  }
  return rows
}

// The name column is last and may hold spaces.
const PS_COMM_COLUMN = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/

const MAX_EXECUTABLE_NAME_CHARS = 64

/** Basename only (paths can carry the user's home directory), without `.exe` so CIM and typeperf agree. */
export function executableBasename(value: string | undefined): string | undefined {
  const base = value
    ?.trim()
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
  return base ? base.slice(0, MAX_EXECUTABLE_NAME_CHARS) : undefined
}

export function collectSubtree(
  index: Pick<ProcIndex, 'byPid' | 'childrenOf'>,
  root: number,
  excludedPids?: ReadonlySet<number>
): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()
    if (pid === undefined) {
      break
    }
    // Earlier PTYs already claimed excluded subtrees; skip their descendants to avoid repeated walks.
    if (seen.has(pid) || excludedPids?.has(pid)) {
      continue
    }
    seen.add(pid)
    if (index.byPid.has(pid)) {
      result.push(pid)
    }
    const kids = index.childrenOf.get(pid)
    if (kids) {
      for (const kid of kids) {
        queue.push(kid)
      }
    }
  }
  return result
}
