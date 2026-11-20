import type { z } from 'zod'
import type { PeerMailDeliverParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { routeBotMail } from '../messaging/bot-chat-address'
import { mayReachBot } from '../messaging/bot-request-send'
import { reconcileBotRequestTakes } from '../messaging/bot-request-take-reconcile'

// Deliveries being admitted on this Orca, by message id.
const admitting = new Set<string>()

/** Peer mail that reaches a bot is admitted as this Orca's own bot mail is, for the owner: a paired
 *  computer has full access here. `{ to }` is mail for an agent that is no bot, stored as peer mail. */
export async function deliverPeerMailToBot(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof PeerMailDeliverParams>,
  peerFingerprint: string,
  senderSnapshot: string | undefined
): Promise<'delivered' | { to: string; body?: string }> {
  const db = runtime.getOrchestrationDb()
  // The label is no party here, so the request reads as the owner's own.
  const sender = {
    address: params.senderLabel,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: null
  }
  const named = params.chat !== undefined || params.item !== undefined
  // A reply carries no type and is stored as a local reply is, never as a new request.
  const reply = params.type === undefined && !named
  if (reply || (!named && !mayReachBot(runtime, params.to, sender))) {
    return { to: params.to }
  }
  db.assertPeerMailConversation(params.conversationId, peerFingerprint)
  const link = () =>
    db.linkPeerMailMessage({
      conversationId: params.conversationId,
      peerFingerprint,
      messageId: params.messageId,
      senderLabel: params.senderLabel
    })
  // A retry while the first attempt is still admitted is refused, never answered for mail that may yet fail.
  if (admitting.has(params.messageId)) {
    throw new OrchestrationError(
      'delivery_in_progress',
      `This mail is still being delivered on ${runtime.readMachineName()}; nothing more was applied.`,
      { effectsApplied: false, retryable: true }
    )
  }
  // A duplicate of mail an earlier build stored before linking it: from a sender that tells its asker
  // once per question (`questionNotice`), it joins that rule once its way back is filed.
  const adoptOneNotice = () => {
    if (params.questionNotice === 'once') {
      const taken = db.adoptBotRequestDebtRule(params.messageId)
      if (taken) {
        void reconcileBotRequestTakes(runtime, taken)
      }
    }
  }
  // Stored by an attempt that ended before linking it: a duplicate, never a second request.
  if (db.getMessageById(params.messageId)) {
    link()
    adoptOneNotice()
    return 'delivered'
  }
  // A restart while a chat was made for it can leave its request held with no mail; nothing is in flight now.
  db.releaseBotRequest(params.messageId)
  admitting.add(params.messageId)
  try {
    const routed = await routeBotMail(
      { runtime, orchestrationCaller: undefined, recordMutationReceipt: undefined },
      {
        params: {
          subject: params.subject,
          body: params.body,
          type: params.type,
          priority: params.priority,
          threadId: params.threadId,
          chat: params.chat,
          item: params.item
        },
        attachments: params.attachments,
        from: params.senderLabel,
        to: params.to,
        sender,
        routing: { run: undefined },
        messageId: params.messageId,
        senderSnapshot,
        // Its reply and any notice go back over this conversation, filed with the request.
        fromPeer: {
          conversationId: params.conversationId,
          peerFingerprint,
          senderLabel: params.senderLabel,
          ...(params.questionNotice ? { questionNotice: params.questionNotice } : {}),
          ...(params.sendKey ? { sendKey: params.sendKey } : {})
        }
      }
    )
    if (!('receipt' in routed)) {
      return routed
    }
    refuseRepeatedSend(runtime, routed.receipt)
    return 'delivered'
  } finally {
    admitting.delete(params.messageId)
  }
}

/** The same send again was refused here: its sender hears so, never a delivery of mail that isn't. */
function refuseRepeatedSend(runtime: OrcaRuntimeService, receipt: unknown): void {
  if (typeof receipt !== 'object' || receipt === null || !('duplicate' in receipt)) {
    return
  }
  const next = 'next' in receipt && typeof receipt.next === 'string' ? receipt.next : ''
  const earlier =
    'message' in receipt &&
    typeof receipt.message === 'object' &&
    receipt.message !== null &&
    'id' in receipt.message
      ? receipt.message.id
      : null
  throw new OrchestrationError(
    'already_sent',
    `${next}${typeof earlier === 'string' ? ` The earlier one is ${earlier} on ${runtime.readMachineName()}.` : ''}`,
    { effectsApplied: false }
  )
}
