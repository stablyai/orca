/**
 * Normalizer for a `diagnostics.memory` payload collected on another host.
 *
 * The remote runtime runs the same collector, but it ships independently, so
 * the payload is untrusted input: fields may be missing on an older host and
 * unknown ones may appear on a newer one. Coerce what we recognize, drop what
 * is malformed, and never throw — a bad row must not take down the panel.
 */

import type {
  AppMemory,
  HostMemory,
  MemorySnapshot,
  ProcessMemoryMetric,
  SessionMemory,
  UsageValues,
  WorktreeMemory
} from '../../shared/process-stats-types'

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function usage(value: unknown): UsageValues {
  const record = asRecord(value)
  return { cpu: num(record?.cpu), memory: num(record?.memory) }
}

function history(value: unknown): number[] {
  return Array.isArray(value) ? value.map(num) : []
}

function appMemory(value: unknown): AppMemory {
  const record = asRecord(value)
  return {
    ...usage(record),
    main: usage(record?.main),
    renderer: usage(record?.renderer),
    other: usage(record?.other),
    history: history(record?.history)
  }
}

// Why: a headless `orca serve` host reports no memory-pressure source; fall back
// to the plain free-memory label rather than inventing a reading we didn't get.
function hostMemory(value: unknown): HostMemory {
  const record = asRecord(value)
  const source = str(record?.availableMemorySource)
  return {
    totalMemory: num(record?.totalMemory),
    freeMemory: num(record?.freeMemory),
    availableMemory: num(record?.availableMemory),
    availableMemorySource:
      source === 'memory-pressure' || source === 'proc-meminfo' ? source : 'free-memory',
    usedMemory: num(record?.usedMemory),
    memoryUsagePercent: num(record?.memoryUsagePercent),
    cpuCoreCount: num(record?.cpuCoreCount),
    loadAverage1m: num(record?.loadAverage1m)
  }
}

function sessions(value: unknown): SessionMemory[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: SessionMemory[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const sessionId = str(record?.sessionId)
    if (!sessionId) {
      continue
    }
    const paneKey = record?.paneKey
    // Why: carry a host-reported name through when there is one, so a host that
    // names its own sessions still works if the title lookup cannot run.
    const title = typeof record?.title === 'string' ? record.title.trim() : ''
    rows.push({
      ...usage(record),
      sessionId,
      paneKey: typeof paneKey === 'string' && paneKey ? paneKey : null,
      pid: num(record?.pid),
      ...(title ? { title } : {})
    })
  }
  return rows
}

function worktrees(value: unknown): WorktreeMemory[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: WorktreeMemory[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const worktreeId = str(record?.worktreeId)
    if (!worktreeId) {
      continue
    }
    const repoId = str(record?.repoId) || worktreeId
    rows.push({
      ...usage(record),
      worktreeId,
      worktreeName: str(record?.worktreeName) || worktreeId,
      repoId,
      repoName: str(record?.repoName) || repoId,
      sessions: sessions(record?.sessions),
      history: history(record?.history)
    })
  }
  return rows
}

/**
 * Returns null when the payload is not recognizably a snapshot at all, which
 * the caller reports as an unreachable host rather than as an idle one.
 */
export function parseRemoteMemorySnapshot(value: unknown): MemorySnapshot | null {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.worktrees)) {
    return null
  }
  const metric: ProcessMemoryMetric =
    record.processMemoryMetric === 'working-set' ? 'working-set' : 'rss'
  return {
    app: appMemory(record.app),
    worktrees: worktrees(record.worktrees),
    host: hostMemory(record.host),
    processMemoryMetric: metric,
    totalCpu: num(record.totalCpu),
    totalMemory: num(record.totalMemory),
    collectedAt: num(record.collectedAt) || Date.now()
  }
}
