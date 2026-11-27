import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageType } from '../../../../orchestration/db/orchestration-records'
import { listUnreadTargetedMessageIds } from '../../../../orchestration/db/messages/message-work-target-provenance'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  isUnreadFollowThroughActive,
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../../../../orchestration/workers/reports/work-target-mail-hold-notice'
import {
  partitionUnreadMessagesForBareRecipient,
  verifyUnreadMailboxMessagesForWorkerDispatch
} from '../../../../../bots/bot-work-target-unread-provenance'
import { routeAllMailboxPages } from './mailbox-page-routing'

/** Move ordinary unread mail from a settled worker Dispatch to its owning Run while holding targeted work mail in place with a deduplicated notice. */
export async function drainSettledDispatchMailboxToRun(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    dispatchId: string
    owningRunId: string
    signal?: AbortSignal
  }
): Promise<void> {
  const { dispatchId, owningRunId, signal } = args
  const address = `dispatch:${dispatchId}`
  const throughSequence = db.getLatestUnreadMessageSequence(address)
  if (throughSequence === undefined) {
    return
  }
  const routedTypes = new Set<MessageType>()
  const routePage = (): { routedCount: number; hasMore: boolean } => {
    const routed = db.routeUnreadDispatchMailboxToRunMailbox(
      dispatchId,
      owningRunId,
      throughSequence
    )
    for (const routedType of routed.types) {
      routedTypes.add(routedType)
    }
    return routed
  }
  const notifyRoutedTypes = (): void => {
    for (const routedType of routedTypes) {
      runtime.notifyMessageArrived(`run:${owningRunId}`, routedType)
    }
    routedTypes.clear()
  }
  const finalizeSettledRouting = (): void => {
    notifyRoutedTypes()
    holdSettledDispatchTargetedMail(runtime, db, dispatchId, owningRunId, throughSequence)
  }
  try {
    await routeAllMailboxPages(routePage, signal)
  } catch (error) {
    notifyRoutedTypes()
    if (error instanceof OrchestrationError && error.code === 'request_aborted') {
      setImmediate(() => {
        void routeAllMailboxPages(routePage)
          .catch(() => undefined)
          .finally(finalizeSettledRouting)
      })
    } else {
      holdSettledDispatchTargetedMail(runtime, db, dispatchId, owningRunId, throughSequence)
    }
    throw error
  }
  finalizeSettledRouting()
}

/** Hold any targeted unread mail left on a settled worker Dispatch instead of moving it to `run:<id>`, notifying once. */
export function holdSettledDispatchTargetedMail(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  owningRunId: string,
  throughSequence: number
): void {
  const heldIds = listUnreadTargetedMessageIds(db, `dispatch:${dispatchId}`, {
    runId: owningRunId,
    throughSequence
  })
  if (heldIds.length === 0) {
    return
  }
  preserveUnreadFollowUpMail(db, dispatchId)
  if (isUnreadFollowThroughActive(db, dispatchId)) {
    return
  }
  notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
    dispatchId,
    heldMessageIds: heldIds,
    reason: `Dispatch ${dispatchId} settled while targeted unread work remained; Orca held the original mail instead of moving it to run:${owningRunId}`,
    runIdFallback: owningRunId
  })
}

/** Route direct mail from `directHandle` to `dispatch:<dispatchId>`, verifying any persisted work-target provenance before moving. */
export async function routeVerifiedDirectMailToDispatch(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    dispatchId: string
    runId: string
    directHandle: string
    signal?: AbortSignal
  }
): Promise<void> {
  const { dispatchId, runId, directHandle, signal } = args
  const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
  if (throughSequence === undefined) {
    return
  }
  const targetedIds = listUnreadTargetedMessageIds(db, directHandle, { runId, throughSequence })
  if (targetedIds.length === 0) {
    await routeAllMailboxPages(
      () =>
        db.routeUnreadDirectMessagesToDispatchMailbox(
          dispatchId,
          runId,
          directHandle,
          throughSequence
        ),
      signal
    )
    return
  }
  const partition = (
    await verifyUnreadMailboxMessagesForWorkerDispatch(runtime, db, {
      destinationDispatchId: dispatchId,
      sourceMailbox: directHandle,
      runId,
      throughSequence
    })
  ).reverifySync()
  if (partition.deliverableIds.length > 0) {
    await routeAllMailboxPages(
      () =>
        db.routeUnreadDirectMessagesToDispatchMailbox(
          dispatchId,
          runId,
          directHandle,
          throughSequence,
          false,
          { onlyMessageIds: partition.deliverableIds }
        ),
      signal
    )
  }
  if (partition.held.length > 0) {
    notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
      dispatchId,
      heldMessageIds: partition.held.map((item) => item.messageId),
      reason: partition.held[0]!.reason,
      runIdFallback: runId
    })
  }
}

/** Route direct mail for `runId` from `directHandle` to `run:<runId>`, verifying targeted mail against the live coordinator. */
export async function routeVerifiedDirectMailToRun(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    runId: string
    directHandle: string
    recipientAddress: string
    signal?: AbortSignal
  }
): Promise<void> {
  const { runId, directHandle, recipientAddress, signal } = args
  const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
  if (throughSequence === undefined) {
    return
  }
  const targetedIds = listUnreadTargetedMessageIds(db, directHandle, { runId, throughSequence })
  if (targetedIds.length === 0) {
    await routeAllMailboxPages(
      () => db.routeUnreadDirectMessagesToRunMailbox(runId, directHandle, throughSequence),
      signal
    )
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one TEXT primary-key column.
  const rows = db.db
    .prepare(
      `SELECT id FROM messages
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery' AND sequence <= ?
       ORDER BY sequence ASC`
    )
    .all(runId, directHandle, throughSequence) as { id: string }[]
  const finalResult = (
    await partitionUnreadMessagesForBareRecipient(runtime, db, recipientAddress, rows)
  ).reverifySync()
  if (finalResult.deliverableIds.length > 0) {
    await routeAllMailboxPages(
      () =>
        db.routeUnreadDirectMessagesToRunMailbox(runId, directHandle, throughSequence, {
          onlyMessageIds: finalResult.deliverableIds
        }),
      signal
    )
  }
  if (finalResult.held.length > 0) {
    notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
      mailboxHandle: directHandle,
      heldMessageIds: finalResult.held.map((item) => item.messageId),
      reason: finalResult.held[0]!.reason,
      runIdFallback: runId
    })
  }
}
