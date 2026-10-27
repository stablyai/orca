import type { ProcessMemoryMetric } from '../../shared/process-stats-types'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'

export type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core; may exceed 100 across cores. */
  cpu: number
  /** Bytes in the snapshot's processMemoryMetric (footprint on macOS when available, else RSS/working set). */
  memory: number
  /** Committed bytes, including paged-out memory; absent when unavailable. */
  privateMemory?: number
}

export type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
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
  let hasPrivateMemory = false
  for (const row of rows) {
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
    hasPrivateMemory,
    memoryMetric: footprints ? 'footprint' : fallbackMetric
  }
}

export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = getProcessOutputFields(line, 4)
    if (fields.length < 4) {
      continue
    }
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const cpu = Number.parseFloat(fields[2])
    const rssKb = Number.parseInt(fields[3], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) {
      continue
    }
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : 0,
      memory: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0
    })
  }
  return rows
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
