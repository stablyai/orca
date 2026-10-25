import type { DispatchContextRow } from '../types'
import type { OrchestrationDb } from './orchestration-db'

/** Legacy tests dispatch as an uncapped root; nesting-specific tests supply their own authority. */
export function createRootDispatch(
  db: OrchestrationDb,
  taskId: string,
  assigneeHandle: string,
  assigneePaneKey?: string,
  launchTokenHash?: string,
  processIncarnation?: string
): DispatchContextRow {
  return db.createDispatchContext({
    taskId,
    assigneeHandle,
    assigneePaneKey,
    launchTokenHash,
    processIncarnation,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
}

/** Re-points a Dispatch at a new pane/process and fences the prior consumer's Delivery. */
export function reattachDispatchConsumer(
  db: OrchestrationDb,
  params: { dispatchId: string; paneKey: string; processIncarnation: string }
): void {
  db.db
    .prepare(
      `UPDATE dispatch_contexts
       SET assignee_pane_key = ?, process_incarnation = ?,
           consumer_generation = consumer_generation + 1
       WHERE id = ?`
    )
    .run(params.paneKey, params.processIncarnation, params.dispatchId)
  db.fenceUnacknowledgedMailboxDeliveries(`dispatch:${params.dispatchId}`)
}
