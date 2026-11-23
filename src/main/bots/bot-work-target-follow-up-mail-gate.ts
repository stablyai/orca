import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { FOLLOW_UP_MESSAGE_TYPES } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-plan'
import { listUnreadTargetedMessageIds } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import {
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../runtime/orchestration/workers/reports/work-target-mail-hold-notice'
import { partitionUnreadMessagesForWorkerDispatch } from './bot-work-target-unread-provenance'

/**
 * Re-verify all unread messages on `takesMailOf` right before `takeFollowUpMail` claims them
 * so mail that arrived or drifted during `followUp.place()` cannot be swept unverified.
 */
export async function resolveVerifiedTakesMailIds(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'showTerminal'
  >,
  db: OrchestrationDb,
  takesMailOf: string,
  verifiedAgainstDispatchId: string
): Promise<string[]> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one TEXT primary-key column.
  const unread = db.db
    .prepare(
      `SELECT id FROM messages
       WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
       ORDER BY sequence ASC`
    )
    .all(`dispatch:${takesMailOf}`) as { id: string }[]
  if (unread.length === 0) {
    return []
  }
  const partition = await partitionUnreadMessagesForWorkerDispatch(
    runtime,
    db,
    verifiedAgainstDispatchId,
    unread
  )
  if (partition.held.length > 0) {
    throw new OrchestrationError('invalid_argument', partition.held[0]!.reason, {
      effectsApplied: false
    })
  }
  return partition.deliverableIds
}

/**
 * Before injecting a `takesMailOf` follow-up prompt at readiness, verify any targeted mail moved
 * onto the starting Dispatch still matches live workspace/registration state; if drifted, return
 * the failed targeted messages to `takesMailOf` as recoverable held mail and notify once.
 */
export async function reverifyTakesMailBeforeHandOver(
  runtime: Pick<
    OrcaRuntimeService,
    | 'showManagedTerminalWorkspace'
    | 'getBotWorkTargetCatalogStore'
    | 'showTerminal'
    | 'notifyMessageArrived'
  >,
  db: OrchestrationDb,
  args: { dispatchId: string; takesMailOf: string; runId: string }
): Promise<void> {
  const { dispatchId, takesMailOf, runId } = args
  const targetedIds = listUnreadTargetedMessageIds(db, `dispatch:${dispatchId}`, { runId })
  if (targetedIds.length === 0) {
    return
  }
  const partition = await partitionUnreadMessagesForWorkerDispatch(
    runtime,
    db,
    dispatchId,
    targetedIds.map((id) => ({ id }))
  )
  if (partition.held.length === 0) {
    return
  }
  const failedIds = partition.held.map((item) => item.messageId)
  let page
  do {
    page = db.routeUnreadDirectMessagesToDispatchMailbox(
      takesMailOf,
      runId,
      `dispatch:${dispatchId}`,
      undefined,
      true,
      { onlyMessageIds: failedIds }
    )
  } while (page.hasMore)
  preserveUnreadFollowUpMail(db, takesMailOf)
  notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
    dispatchId: takesMailOf,
    heldMessageIds: failedIds,
    reason: partition.held[0]!.reason,
    runIdFallback: runId
  })
  if (db.getUnreadMessages(`dispatch:${dispatchId}`, [...FOLLOW_UP_MESSAGE_TYPES]).length === 0) {
    throw new OrchestrationError('invalid_argument', partition.held[0]!.reason, {
      effectsApplied: false
    })
  }
}
