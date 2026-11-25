import type { z } from 'zod'
import type { PeerMailDeliverParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { peerGroupHome } from '../../../../orchestration/federation/peer-mail/peer-group-question'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { routeBotMail } from '../messaging/bot-chat-address'
import { botAddressReach } from '../messaging/bot-recipient'
import { pairedLabelComputer } from '../../../../../../shared/orchestration/mailbox/paired-sender-name'
import { agentMessageSenderName } from '../../../../../../shared/agent-session/journal/agent-session-message-source'

// Deliveries being admitted on this Orca, by message id.
const admitting = new Set<string>()

/** Peer mail that reaches a bot is admitted as this Orca's own bot mail is, for the owner: a paired
 *  computer has full access here. `{ to }` is mail for an agent that is no bot, stored as peer mail. */
export async function deliverPeerMailToBot(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof PeerMailDeliverParams>,
  peerFingerprint: string,
  senderSnapshot: string | undefined,
  /** Mail a server this Orca dials queued for it: its conversation names that server, and
   *  `alsoOnAdmitted` commits with the request's admission. */
  pulled?: { environmentId: string; serverName: string; alsoOnAdmitted: () => void }
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
  const group = params.group
  if (group?.kind === 'question') {
    if (
      params.to !== `bot:${group.botId}` ||
      !params.chat ||
      params.type !== 'question' ||
      params.threadId !== undefined ||
      params.item !== undefined
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        'A group question must address a pinned Home Chat.',
        { effectsApplied: false }
      )
    }
    peerGroupHome(runtime, group.botId, params.chat)
  }
  // A reply carries no type and is stored as a local reply is, never as a new request.
  const reply = params.type === undefined && !named
  const reach = (): boolean =>
    botAddressReach(runtime, db, params.to, sender, { fromPairedComputer: true }).kind !== 'none'
  if (reply || (!named && !reach())) {
    return { to: params.to }
  }
  db.assertPeerMailConversation(params.conversationId, peerFingerprint)
  const link = () => {
    if (group?.kind === 'question') {
      peerGroupHome(runtime, group.botId, params.chat)
    }
    db.linkPeerMailMessage({
      conversationId: params.conversationId,
      peerFingerprint,
      messageId: params.messageId,
      senderLabel: params.senderLabel,
      ...(group?.kind === 'question' ? { groupQuestion: JSON.stringify(group) } : {}),
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
        // Its reply and any notice go back over this conversation, linked before the bot is woken.
        onAdmitted: link
      }
    )
    if (group?.kind === 'question' && !('receipt' in routed)) {
      throw new OrchestrationError(
        'request_mismatch',
        'The group question was not admitted by its bot.',
        { effectsApplied: false }
      )
    }
    if (!('receipt' in routed)) {
      return routed
    }
    link()
    return 'delivered'
  } finally {
    admitting.delete(params.messageId)
  }
}
