import { ORCHESTRATION_UNBOUND_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import {
  listUnreadTargetedMessageIds,
  readMessagesWorkTargetProvenance
} from '../../../../orchestration/db/messages/message-work-target-provenance'
import {
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../../../../orchestration/workers/reports/work-target-mail-hold-notice'
import {
  partitionUnreadMessagesForBareRecipient,
  partitionUnreadMessagesForWorkerDispatch,
  type UnreadMessageTargetPartition,
  type UnreadMessageTargetPartitionResult
} from '../../../../../bots/bot-work-target-unread-provenance'
import type { CheckMailTargetVerification } from './check-mail-reconciliation'

export type WorkTargetMailboxTarget =
  | { kind: 'dispatch'; dispatchId: string }
  | { kind: 'bare'; recipientAddress: string }

function partitionForTarget(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  target: WorkTargetMailboxTarget,
  messages: readonly Pick<MessageRow, 'id'>[]
): Promise<UnreadMessageTargetPartition> {
  return target.kind === 'dispatch'
    ? partitionUnreadMessagesForWorkerDispatch(runtime, db, target.dispatchId, messages)
    : partitionUnreadMessagesForBareRecipient(runtime, db, target.recipientAddress, messages)
}

function emitHeldNotice(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    target: WorkTargetMailboxTarget
    mailboxHandle: string
    runId?: string
    held: readonly { messageId: string; reason: string }[]
  }
): void {
  if (args.held.length === 0) {
    return
  }
  const runIdFallback =
    args.runId && args.runId !== ORCHESTRATION_UNBOUND_RUN_ID ? args.runId : undefined
  if (args.target.kind === 'dispatch') {
    preserveUnreadFollowUpMail(db, args.target.dispatchId)
  }
  notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
    ...(args.target.kind === 'dispatch'
      ? { dispatchId: args.target.dispatchId }
      : { mailboxHandle: args.mailboxHandle }),
    runIdFallback,
    heldMessageIds: args.held.map((item) => item.messageId),
    reason: args.held[0]!.reason
  })
}

function unreadTargetedMessagesOf(
  db: OrchestrationDb,
  messages: readonly MessageRow[]
): MessageRow[] {
  const unread = messages.filter((message) => !message.read)
  if (unread.length === 0) {
    return []
  }
  const provenance = readMessagesWorkTargetProvenance(
    db,
    unread.map((message) => message.id)
  )
  return unread.filter((message) => {
    const entry = provenance.get(message.id)
    return entry !== undefined && entry.kind !== 'absent'
  })
}

/** Filter unread targeted messages for non-consuming read/peek/history views so unverified work is never exposed. */
export async function filterReadableMailboxMessages(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    target: WorkTargetMailboxTarget | undefined
    mailboxHandle: string
    runId?: string
    messages: MessageRow[]
  }
): Promise<MessageRow[]> {
  if (!args.target) {
    return args.messages
  }
  const targetedUnread = unreadTargetedMessagesOf(db, args.messages)
  if (targetedUnread.length === 0) {
    return args.messages
  }
  const finalResult = (
    await partitionForTarget(runtime, db, args.target, targetedUnread)
  ).reverifySync()
  if (finalResult.held.length === 0) {
    return args.messages
  }
  const heldIds = new Set(finalResult.held.map((item) => item.messageId))
  return args.messages.filter((message) => !heldIds.has(message.id))
}

function makeCommitVerifier(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: { target: WorkTargetMailboxTarget; mailboxHandle: string; runId?: string }
): CheckMailTargetVerification {
  return async (selected) => {
    const targetedUnread = unreadTargetedMessagesOf(db, selected)
    if (targetedUnread.length === 0) {
      return {
        reverifySync: () => ({
          allowedIds: new Set(selected.map((message) => message.id)),
          onHeld: () => undefined
        })
      }
    }
    const partition = await partitionForTarget(runtime, db, args.target, targetedUnread)
    return {
      reverifySync: () => {
        const finalResult: UnreadMessageTargetPartitionResult = partition.reverifySync()
        const heldIds = new Set(finalResult.held.map((item) => item.messageId))
        return {
          allowedIds: new Set(
            selected.filter((message) => !heldIds.has(message.id)).map((message) => message.id)
          ),
          onHeld: () =>
            emitHeldNotice(runtime, db, {
              target: args.target,
              mailboxHandle: args.mailboxHandle,
              runId: args.runId ?? selected.find((m) => heldIds.has(m.id))?.run_id,
              held: finalResult.held
            })
        }
      }
    }
  }
}

/**
 * Prepare pre-selection exclusion, tainted-outstanding-delivery fencing, and commit-time
 * verification for role mailboxes (`dispatch:<id>` or `run:<id>`). Fast-paths when untargeted.
 */
export async function prepareRoleDeliveryWorkTargetGate(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    target: WorkTargetMailboxTarget
    mailboxHandle: string
    runId: string
    consumerGeneration: number
  }
): Promise<{
  excludeMessageIds: string[] | undefined
  verifySelected: CheckMailTargetVerification
  flushHeld: () => void
}> {
  const verifySelected = makeCommitVerifier(runtime, db, args)
  const outstanding = db.getOutstandingMailboxDelivery(args.mailboxHandle)
  const candidateIds = new Set<string>(
    listUnreadTargetedMessageIds(db, args.mailboxHandle, { runId: args.runId })
  )
  if (outstanding?.messageIds.length) {
    const provenance = readMessagesWorkTargetProvenance(db, outstanding.messageIds)
    for (const id of outstanding.messageIds) {
      const entry = provenance.get(id)
      if (entry && entry.kind !== 'absent') {
        candidateIds.add(id)
      }
    }
  }
  if (candidateIds.size === 0) {
    return { excludeMessageIds: undefined, verifySelected, flushHeld: () => undefined }
  }
  const finalResult = (
    await partitionForTarget(
      runtime,
      db,
      args.target,
      [...candidateIds].map((id) => ({ id }))
    )
  ).reverifySync()
  if (finalResult.held.length === 0) {
    return { excludeMessageIds: undefined, verifySelected, flushHeld: () => undefined }
  }
  const heldIds = finalResult.held.map((item) => item.messageId)
  const heldIdSet = new Set(heldIds)
  if (outstanding && outstanding.messageIds.some((id) => heldIdSet.has(id))) {
    db.fenceOutstandingMailboxDelivery(outstanding.id, args.consumerGeneration)
  }
  return {
    excludeMessageIds: heldIds,
    verifySelected,
    flushHeld: () =>
      emitHeldNotice(runtime, db, {
        target: args.target,
        mailboxHandle: args.mailboxHandle,
        runId: args.runId,
        held: finalResult.held
      })
  }
}

/** Verify targeted direct mail before `takeDirect` marks it read, holding mismatched rows unread with one notice. */
export async function prepareDirectDeliveryWorkTargetGate(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    recipientAddress: string
    mailboxHandle: string
    selected: MessageRow[]
    fallbackRunId?: string
  }
): Promise<{
  deliverable: MessageRow[]
  verifySelected: CheckMailTargetVerification
  flushHeld: () => void
}> {
  const target: WorkTargetMailboxTarget = { kind: 'bare', recipientAddress: args.recipientAddress }
  const verifySelected = makeCommitVerifier(runtime, db, {
    target,
    mailboxHandle: args.mailboxHandle,
    runId: args.fallbackRunId
  })
  const targetedUnread = unreadTargetedMessagesOf(db, args.selected)
  if (targetedUnread.length === 0) {
    return { deliverable: args.selected, verifySelected, flushHeld: () => undefined }
  }
  const finalResult = (await partitionForTarget(runtime, db, target, targetedUnread)).reverifySync()
  if (finalResult.held.length === 0) {
    return { deliverable: args.selected, verifySelected, flushHeld: () => undefined }
  }
  const heldIds = new Set(finalResult.held.map((item) => item.messageId))
  const runIdForHold =
    args.fallbackRunId ?? args.selected.find((message) => heldIds.has(message.id))?.run_id
  return {
    deliverable: args.selected.filter((message) => !heldIds.has(message.id)),
    verifySelected,
    flushHeld: () =>
      emitHeldNotice(runtime, db, {
        target,
        mailboxHandle: args.mailboxHandle,
        runId: runIdForHold,
        held: finalResult.held
      })
  }
}
