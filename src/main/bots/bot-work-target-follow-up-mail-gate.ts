import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  clearFollowUpMail,
  takeFollowUpMail
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { FOLLOW_UP_MESSAGE_TYPES } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-plan'
import { listUnreadTargetedMessageIds } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import {
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../runtime/orchestration/workers/reports/work-target-mail-hold-notice'
import {
  partitionUnreadMessagesForResolvedWorkspace,
  partitionUnreadMessagesForWorkerDispatch,
  type UnreadMessageTargetPartition
} from './bot-work-target-unread-provenance'

/**
 * Preflight `takesMailOf` before creating the starting Dispatch: fail closed only when nothing is
 * deliverable, and return ONLY ordinary (untargeted) IDs for early claim so targeted mail never
 * enters the pending Dispatch until final workspace verification passes right before binding.
 */
export async function resolveInitialOrdinaryTakesMailIds(
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
  if (partition.deliverableIds.length === 0 && partition.held.length > 0) {
    throw new OrchestrationError('invalid_argument', partition.held[0]!.reason, {
      effectsApplied: false
    })
  }
  return partition.ordinaryIds
}

/**
 * Verify targeted `takesMailOf` mail against the placed worker BEFORE `bindTerminal()` exposes the
 * pending Dispatch to `orchestration.check`, then bind and transfer verified targeted IDs in one
 * synchronous turn with a live registration re-check so drifted mail stays held on `takesMailOf`.
 */
export async function verifyAndBindTakesMailForHandOver(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore' | 'notifyMessageArrived'
  >,
  db: OrchestrationDb,
  args: {
    dispatchId: string
    takesMailOf: string | undefined
    runId: string
    worktreeId: string
    worktreeInstanceId: string | null
    workerHostScope: string | null | undefined
    bindTerminal: () => void
  }
): Promise<void> {
  const {
    dispatchId,
    takesMailOf,
    runId,
    worktreeId,
    worktreeInstanceId,
    workerHostScope,
    bindTerminal
  } = args
  if (!takesMailOf) {
    bindTerminal()
    return
  }
  const targetedOnParent = listUnreadTargetedMessageIds(db, `dispatch:${takesMailOf}`, { runId })
  let partition: UnreadMessageTargetPartition | undefined
  if (targetedOnParent.length > 0) {
    partition = await partitionUnreadMessagesForResolvedWorkspace(
      runtime,
      db,
      {
        worktreeId,
        recipientLabel: `dispatch:${dispatchId}`,
        workerHostScope,
        workerWorkspaceInstanceId: worktreeInstanceId
      },
      targetedOnParent.map((id) => ({ id }))
    )
  }
  // Synchronous boundary: re-check live registration with zero awaits before bindTerminal + transfer.
  const finalResult = partition ? partition.reverifySync() : undefined
  const verifiedTargetedIds = finalResult?.verifiedTargetedIds ?? []
  const held = finalResult?.held ?? []
  if (held.length > 0) {
    preserveUnreadFollowUpMail(db, takesMailOf)
    notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
      dispatchId: takesMailOf,
      heldMessageIds: held.map((item) => item.messageId),
      reason: held[0]!.reason,
      runIdFallback: runId
    })
  }
  const hasOrdinaryOnChild = db.getUnreadMessages(`dispatch:${dispatchId}`).length > 0
  if (verifiedTargetedIds.length === 0 && !hasOrdinaryOnChild && held.length > 0) {
    throw new OrchestrationError('invalid_argument', held[0]!.reason, {
      effectsApplied: false
    })
  }
  bindTerminal()
  if (verifiedTargetedIds.length > 0) {
    takeFollowUpMail(db, takesMailOf, dispatchId, verifiedTargetedIds)
    if (
      db.getUnreadMessages(`dispatch:${takesMailOf}`, [...FOLLOW_UP_MESSAGE_TYPES]).length === 0
    ) {
      clearFollowUpMail(db, takesMailOf)
    }
  }
}
