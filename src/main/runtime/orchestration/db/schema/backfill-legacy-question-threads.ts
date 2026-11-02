import { LEGACY_RUN_ID, LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

export function backfillLegacyQuestionThreads(this: OrchestrationDb): void {
  const messages = this.db
    .prepare(
      `SELECT id, run_id, from_handle, to_handle, payload, created_at, sequence
       FROM messages
       WHERE type = 'decision_gate'
         AND delivery_contract IN ('legacy_direct', 'current_delivery')
       ORDER BY sequence`
    )
    .all() as {
    id: string
    run_id: string
    from_handle: string
    to_handle: string
    payload: string | null
    created_at: string
    sequence: number
  }[]
  const getDispatch = this.db.prepare(
    'SELECT id, run_id, task_id FROM dispatch_contexts WHERE id = ? AND contract_version = ?'
  )
  const getDispatchesForLegacyQuestion = this.db.prepare(
    `SELECT id, run_id, task_id
     FROM dispatch_contexts
     WHERE contract_version = ? AND assignee_handle = ?
       AND (? IS NULL OR task_id = ?)
       AND created_at <= ?
       AND (completed_at IS NULL OR completed_at >= ?)
     ORDER BY rowid
     LIMIT 2`
  )
  const getAnswer = this.db.prepare(
    `SELECT id, body, created_at
     FROM messages
     WHERE run_id = ?
       AND thread_id = ?
       AND delivery_contract IN ('legacy_direct', 'current_delivery')
       AND from_handle = ?
       AND to_handle IN (?, ?)
       AND sequence > ?
     ORDER BY sequence
     LIMIT 1`
  )
  const insert = this.db.prepare(
    `INSERT OR IGNORE INTO question_threads (
       message_id, run_id, dispatch_id, asker_handle, status,
       answer_message_id, answer_body, created_at, answered_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const message of messages) {
    let payload: { taskId?: unknown; dispatchId?: unknown }
    try {
      payload = JSON.parse(message.payload ?? '{}') as {
        taskId?: unknown
        dispatchId?: unknown
      }
    } catch {
      continue
    }
    const inferredDispatches =
      typeof payload.dispatchId === 'string'
        ? []
        : (getDispatchesForLegacyQuestion.all(
            LEGACY_CONTRACT_VERSION,
            message.from_handle,
            typeof payload.taskId === 'string' ? payload.taskId : null,
            typeof payload.taskId === 'string' ? payload.taskId : null,
            message.created_at,
            message.created_at
          ) as { id: string; run_id: string; task_id: string }[])
    const dispatch =
      typeof payload.dispatchId === 'string'
        ? (getDispatch.get(payload.dispatchId, LEGACY_CONTRACT_VERSION) as
            | { id: string; run_id: string; task_id: string }
            | undefined)
        : inferredDispatches.length === 1
          ? inferredDispatches[0]
          : undefined
    if (
      !dispatch ||
      (typeof payload.taskId === 'string' && payload.taskId !== dispatch.task_id) ||
      (message.run_id !== LEGACY_RUN_ID && message.run_id !== dispatch.run_id)
    ) {
      continue
    }
    const answer = getAnswer.get(
      message.run_id,
      message.id,
      message.to_handle,
      message.from_handle,
      `dispatch:${dispatch.id}`,
      message.sequence
    ) as { id: string; body: string; created_at: string } | undefined
    insert.run(
      message.id,
      dispatch.run_id,
      dispatch.id,
      message.from_handle,
      answer ? 'answered' : 'pending',
      answer?.id ?? null,
      answer?.body ?? null,
      message.created_at,
      answer?.created_at ?? null
    )
  }
  const adoption = this.getLegacyAdoption()
  const coordinator = adoption
    ? this.getLegacyCoordinatorPrincipal(adoption.adopted_run_id)
    : undefined
  if (adoption && coordinator?.status === 'revoked') {
    this.promoteLegacyCoordinatorMailForTakeover(
      adoption.adopted_run_id,
      coordinator.terminal_handle
    )
  }
}

export type BackfillLegacyQuestionThreadsMethods = {
  backfillLegacyQuestionThreads: typeof backfillLegacyQuestionThreads
}

export function attachBackfillLegacyQuestionThreads(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    backfillLegacyQuestionThreads
  })
}
