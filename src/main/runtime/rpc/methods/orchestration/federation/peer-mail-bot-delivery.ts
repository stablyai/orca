import type { z } from 'zod'
import type { PeerMailDeliverParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { routeBotMail } from '../messaging/bot-chat-address'
import { botAddressReach } from '../messaging/bot-recipient'
import { pairedLabelComputer } from '../../../../../../shared/orchestration/mailbox/paired-sender-name'
import { agentMessageSenderName } from '../../../../../../shared/agent-session/journal/agent-session-message-source'

// Deliveries being admitted on this Orca, by message id.
const admitting = new Set<string>()

/** Peer mail that reaches a bot is admitted as this Orca's own bot mail is, for the owner: a paired
 *  computer has full access here. Mail pulled from a server this Orca dials acts for no one here,
 *  since that server has none. `{ to }` is mail for an agent that is no bot, stored as peer mail. */
export async function deliverPeerMailToBot(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof PeerMailDeliverParams>,
  peerFingerprint: string,
  senderSnapshot: string | undefined,
  /** Mail a server this Orca dials queued for it: its conversation names that server, and
   *  `alsoOnAdmitted` commits with the request's admission. `admits` is asked inside that write,
   *  with the bot it reaches: false refuses it, so nothing goes to a bot it wasn't approved for. */
  pulled?: {
    environmentId: string
    serverName: string
    admits: (botId: string) => boolean
    alsoOnAdmitted: () => void
  }
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
  const link = () => {
    db.linkPeerMailMessage({
      conversationId: params.conversationId,
      peerFingerprint,
      messageId: params.messageId,
      senderLabel: params.senderLabel,
      ...(pulled ? { environmentId: pulled.environmentId } : {})
    })
    pulled?.alsoOnAdmitted()
  }
  // A retry while the first attempt is still admitted is refused, never answered for mail that may yet fail.
  if (admitting.has(params.messageId)) {
    throw new OrchestrationError(
      'delivery_in_progress',
      `This mail is still being delivered on ${runtime.readMachineName()}; nothing more was applied.`,
      { effectsApplied: false, retryable: true }
    )
  }
  // A pulled ask's link is committed with admission. An existing message id on its own cannot
  // establish that the stored request came over this pairing.
  if (db.getMessageById(params.messageId)) {
    if (pulled) {
      if (
        db.getPeerMailMessage(params.messageId)?.conversation_id !== params.conversationId ||
        !pulled.admits(db.getBotRequest(params.messageId)?.to_bot_id ?? '')
      ) {
        return { to: params.to }
      }
      pulled.alsoOnAdmitted()
    } else {
      link()
    }
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
        // Who it is from, either side of the pairing: a server this computer pulls from by this
        // computer's catalog name for it, a client by its Orca's name for itself. It grants nothing here.
        pairedSender: {
          computer: pulled
            ? pulled.serverName
            : (agentMessageSenderName(params.sender?.computer) ??
              pairedLabelComputer(params.senderLabel) ??
              ''),
          botName: agentMessageSenderName(params.sender?.bot?.name)
        },
        ...(pulled ? { pulledFromServer: true } : {}),
        // Its reply and any notice go back over this conversation, linked before the bot is woken.
        onAdmitted: (botId) => {
          if (pulled && !pulled.admits(botId)) {
            throw new OrchestrationError(
              'request_mismatch',
              'This ask is no longer approved for that agent. Nothing was delivered.',
              { effectsApplied: false }
            )
          }
          link()
        }
      }
    )
    if (!('receipt' in routed)) {
      return routed
    }
    if (pulled) {
      // A duplicate receipt for a different request does not run onAdmitted.
      return db.getPeerMailMessage(params.messageId)?.conversation_id === params.conversationId
        ? 'delivered'
        : { to: params.to }
    }
    link()
    return 'delivered'
  } finally {
    admitting.delete(params.messageId)
  }
}
