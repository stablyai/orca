import type { ControlPlaneStore } from './control-plane-store'
import type { OrchestrationDb } from '../db'

/** Correction — a `serialize` decision has to actually serialize something.
 *
 *  Intake recorded overlap decisions and nothing read them, so two outcomes an
 *  operator explicitly said must not run together could both launch workers.
 *  This is the consumer: a Run whose outcome is serialized against another may
 *  not start work while that other outcome has a live Dispatch.
 */

export type SerializationVerdict =
  | { allowed: true }
  | {
      allowed: false
      code: 'serialized_with_active_outcome'
      blockingOutcomeId: string
      blockingRunId: string
      blockingDispatchId: string
      reason: string
    }

const ACTIVE_STATUSES = ['pending', 'dispatched'] as const

export function assertOutcomeSerializationAllowed(args: {
  db: OrchestrationDb
  store: ControlPlaneStore
  runId: string
}): SerializationVerdict {
  const outcome = args.store.getOutcomeByRun(args.runId)
  if (!outcome) {
    return { allowed: true }
  }
  for (const relation of args.store.listOutcomeRelations(outcome.outcome_id)) {
    if (relation.decision !== 'serialize') {
      continue
    }
    const otherId =
      relation.left_outcome_id === outcome.outcome_id
        ? relation.right_outcome_id
        : relation.left_outcome_id
    const other = args.store.getOutcomeById(otherId)
    if (!other) {
      continue
    }
    const active = args.db.db
      .prepare(
        `SELECT id FROM dispatch_contexts
         WHERE run_id = ? AND status IN ('pending', 'dispatched')
         ORDER BY rowid ASC LIMIT 1`
      )
      .get(other.run_id) as { id: string } | undefined
    if (active) {
      return {
        allowed: false,
        code: 'serialized_with_active_outcome',
        blockingOutcomeId: other.outcome_id,
        blockingRunId: other.run_id,
        blockingDispatchId: active.id,
        reason: `Outcome ${outcome.outcome_id} is serialized against ${other.outcome_id}, which has an active Dispatch (${active.id}). Wait for it to settle before starting work here.`
      }
    }
  }
  return { allowed: true }
}

export const SERIALIZATION_ACTIVE_STATUSES = ACTIVE_STATUSES
