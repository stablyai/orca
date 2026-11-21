import type { z } from 'zod'
import type { PeerMailDeliverParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { routeBotMail } from '../messaging/bot-chat-address'
import { botAddressReach } from '../messaging/bot-recipient'

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
  const reach = (): boolean =>
    botAddressReach(runtime, db, params.to, sender, { fromPairedComputer: true }).kind !== 'none'
  if (reply || (!named && !reach())) {
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
  // Stored by an attempt that ended before linking it: a duplicate, never a second request.
  if (db.getMessageById(params.messageId)) {
    link()
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
        senderSnapshot
      }
    )
    if (!('receipt' in routed)) {
      return routed
    }
    // Its reply and any notice go back over this conversation.
    link()
    return 'delivered'
  } finally {
    admitting.delete(params.messageId)
  }
}
