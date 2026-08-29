import type { MemorySnapshot, ProcessCommitMetric } from '../../shared/process-stats-types'

const PROCESS_COMMIT_METRIC: ProcessCommitMetric = 'private-bytes'

export function clampMemoryMetric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

/**
 * The one rule for every committed-bytes key: present only when the sweep could
 * measure it, because a 0 would read as "these processes commit nothing".
 */
export function optionalCommitField(
  hasPrivateMemory: boolean,
  privateMemory: number
): { privateMemory?: number } {
  return hasPrivateMemory ? { privateMemory: clampMemoryMetric(privateMemory) } : {}
}

/** The snapshot-level pair, which names the unit alongside the total. */
export function snapshotCommitFields(
  hasAnyPrivateMemory: boolean,
  hasCompleteTotal: boolean,
  totalPrivateMemory: number
): Pick<MemorySnapshot, 'processCommitMetric' | 'totalPrivateMemory'> {
  return {
    ...(hasAnyPrivateMemory ? { processCommitMetric: PROCESS_COMMIT_METRIC } : {}),
    ...(hasCompleteTotal ? { totalPrivateMemory: clampMemoryMetric(totalPrivateMemory) } : {})
  }
}
