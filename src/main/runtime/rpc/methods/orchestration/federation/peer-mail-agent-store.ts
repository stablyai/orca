import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  GROUP_ANSWER_CONTEXT_PAYLOAD,
  type PeerMailDeliverParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveBareOrchestrationRecipient } from '../messaging/recipient-routing'
import { prepareSessionRecipient } from '../messaging/session-recipient'

const NOTHING_DELIVERED = { effectsApplied: false } as const

/** Stores peer mail for an agent that is no bot (or a reply to one) as this Orca's own mail, once.
 *  `landedAgain` reads whether a copy landed while the recipient was being prepared; `received`
 *  makes the answer for a stored copy from its mailbox and whether a waiter takes it. */
export async function storePeerMailForAgent<R>(
  runtime: OrcaRuntimeService,
  params: Pick<
    z.infer<typeof PeerMailDeliverParams>,
    'conversationId' | 'messageId' | 'senderLabel' | 'subject' | 'type' | 'priority' | 'threadId'
  > & {
    to: string
    body: string | undefined
    peerFingerprint: string
    /** The server this Orca dials that opened the conversation, for mail it pulled. */
    environmentId?: string
    senderSnapshot: string | undefined
    groupContinuation?: () => string
    /** Whether the resolved recipient may take it; otherwise it is dropped with a warning. */
    admits?: (to: string) => boolean
  },
  landedAgain: () => R | null | Promise<R | null>,
  received?: (to: string, takenByWaiter: boolean) => R | Promise<R>
): Promise<R | null> {
  const db = runtime.getOrchestrationDb()
  const { to } = params
  const terminalRecipient = await prepareSessionRecipient(runtime, to)
  // Read again after the wait: a copy of this delivery may have landed meanwhile.
  const landed = await landedAgain()
  if (landed) {
    return landed
  }
  const recipient = resolveBareOrchestrationRecipient({
    runtime,
    db,
    handle: to,
    terminalRecipient
  })
  if (!recipient.ok) {
    throw new OrchestrationError(
      recipient.code,
      `${recipient.message} Nothing was delivered.`,
      NOTHING_DELIVERED
    )
  }
  if (params.groupContinuation && recipient.to !== params.groupContinuation()) {
    throw new OrchestrationError(
      'request_mismatch',
      'The group answer’s receiving Home Chat changed. Nothing was delivered.',
      NOTHING_DELIVERED
    )
  }
  if (params.admits && !params.admits(recipient.to) && !params.admits(to)) {
    console.warn(
      `[orchestration] Dropped ${params.messageId} for ${to}: it took no part in that conversation`
    )
    return null
  }
  const paneKey = runtime.getLiveTerminalPaneKey(recipient.to)
  if (paneKey && db.findActiveRemoteAttachmentForPane(paneKey)) {
    // Its mailbox is its Dispatch, which only its Run home writes to.
    throw new OrchestrationError(
      'invalid_argument',
      `${to} is a worker for another Orca's Run; message it through that Run's coordinator. Nothing was delivered.`,
      NOTHING_DELIVERED
    )
  }
  // Before storing, as a local send does: a waiter the arrival resolves is gone by the time the receipt reads.
  const takenByWaiter = runtime.hasMessageWaiterFor(recipient.to, params.type ?? 'status')
  const stored = db.insertPeerMailMessage({
    conversationId: params.conversationId,
    peerFingerprint: params.peerFingerprint,
    ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    remoteParty: null,
    message: {
      id: params.messageId,
      from: params.senderLabel,
      to: recipient.to,
      subject: params.subject,
      body: params.body,
      type: params.type,
      priority: params.priority,
      threadId: params.threadId,
      runId: recipient.runId,
      answerSenderSnapshot: params.senderSnapshot,
      ...(params.groupContinuation ? { payload: GROUP_ANSWER_CONTEXT_PAYLOAD } : {})
    }
  })
  if (!stored.duplicate) {
    runtime.notifyMessageArrived(stored.message.to_handle, stored.message.type)
  }
  return received ? received(recipient.to, takenByWaiter) : null
}
