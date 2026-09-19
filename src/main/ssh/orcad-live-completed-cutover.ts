import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parseOrcadLiveCompletionEvidence } from '../../shared/orcad-live-source-completion-evidence'

/** Candidate only: completion evidence must be joined to durable files under current authority. */
export function createOrcadLiveCompletedCutover(options: {
  committed: unknown
  completionEvidence: unknown
  retiredAt: string
}) {
  const committed = parseOrcadMigrationSourceCutover(options.committed)
  if (committed.version !== 2 || committed.phase !== 'destination-committed') {
    throw new Error('orcad_live_completed_successor_commit_required')
  }
  const sourceCompletion = parseOrcadLiveCompletionEvidence(options.completionEvidence)
  const { retiredAt } = options
  if (
    typeof retiredAt !== 'string' ||
    !Number.isFinite(Date.parse(retiredAt)) ||
    Date.parse(retiredAt) < Date.parse(committed.updatedAt)
  ) {
    throw new Error('orcad_live_completed_successor_time_invalid')
  }
  return {
    ...committed,
    version: 2 as const,
    phase: 'source-retired' as const,
    updatedAt: retiredAt,
    retiredAt,
    sourceCompletion
  }
}

/** Exact successor comparison; never ignore arbitrary phase, timestamp, or publication changes. */
export function assertOrcadLiveCompletedCutover(options: {
  committed: unknown
  completed: unknown
  completionEvidence: unknown
}) {
  const completed = options.completed
  if (
    !completed ||
    typeof completed !== 'object' ||
    Array.isArray(completed) ||
    !('retiredAt' in completed) ||
    typeof completed.retiredAt !== 'string'
  ) {
    throw new Error('orcad_live_completed_successor_invalid')
  }
  const expected = createOrcadLiveCompletedCutover({
    committed: options.committed,
    completionEvidence: options.completionEvidence,
    retiredAt: completed.retiredAt
  })
  if (serializeOrcadMigrationValue(completed) !== serializeOrcadMigrationValue(expected)) {
    throw new Error('orcad_live_completed_successor_mismatch')
  }
  return expected
}
