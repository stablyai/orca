// What this computer does with an item a paired server queued for it, decided once at import, in
// one write, so a slow admission never holds the pull: an ask its people allowed is admitted after
// the acknowledgment, one they introduced waits for a person, anything else is declined.
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { isGeneratedId } from '../../db/generated-id'
import {
  ClientAskPayload,
  ClientReplyPayload
} from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { PeerMailSender } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { botOfAddress, parseBotAddress } from '../../../../../shared/bot-roster'
import { toSafeDisplayLine } from '../../../../../shared/text/display-text-safety'
import { queuePeerMailReply } from '../peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../peer-mail/peer-mail-waiters'
import { peerMailSenderSnapshot } from '../peer-mail/peer-mail-sender-snapshot'
import { storePeerMailForAgent } from '../../../rpc/methods/orchestration/federation/peer-mail-agent-store'
import {
  dropPairedServerAsk,
  getPairedServerAsk,
  holdPairedServerAsk,
  isIntroduced,
  isServerAllowed,
  isServerKnown,
  type PairedServerAskRow
} from '../../db/federation/paired-server-asks-store'
import type { PairedServerAsks } from './paired-server-asks-pull'
import { notifyPairedServerCardsChanged } from './paired-server-card-notices'

const Withdrawn = z.object({ requestId: z.string().min(1) })

export type PulledItem = {
  conversationId: string
  messageId: string
  kind?: string
  payload: string
}

export const PAIRED_SERVER_ITEM_KINDS: ReadonlySet<string> = new Set([
  'client_ask',
  'client_reply',
  'client_ask_withdraw'
])

function isDeclined(db: OrchestrationDb, conversationId: string, messageId: string): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = 'to_home' AND message_id = ?`
      )
      .get(conversationId, `${messageId}_declined`) !== undefined
  )
}

/** Its asker hears "Declined" with no reason: by the reply route, so a question settles by its id.
 *  The notice's id follows the ask's, so a replayed import queues no second one. */
export function declinePairedServerAsk(
  runtime: Pick<OrcaRuntimeService, 'readMachineName'>,
  db: OrchestrationDb,
  ask: { conversationId: string; messageId: string; to: string; subject: string }
): void {
  const noticeId = `${ask.messageId}_declined`
  if (isDeclined(db, ask.conversationId, ask.messageId)) {
    return
  }
  const machine = runtime.readMachineName()
  queuePeerMailReply(db, ask.conversationId, noticeId, {
    senderLabel: `${ask.to} on ${machine}`,
    fromAddress: ask.to,
    subject: ask.subject.startsWith('Re: ') ? ask.subject : `Re: ${ask.subject}`,
    body: `Declined on ${machine}.`,
    threadId: ask.messageId,
    notice: { requestId: ask.messageId }
  })
  notifyPeerMailQueued(db.db)
}

/** A held ask is declined once: its row goes, and its asker is told, even when it can't be read. */
export function declineHeldPairedServerAsk(
  runtime: Pick<OrcaRuntimeService, 'readMachineName' | 'getOrchestrationDb'>,
  row: PairedServerAskRow
): void {
  const db = runtime.getOrchestrationDb()
  const ask = ClientAskPayload.safeParse(safeJson(row.payload))
  if (dropPairedServerAsk(db, row.message_id)) {
    declinePairedServerAsk(runtime, db, {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      to: ask.success ? ask.data.to : `bot:${row.bot_id}`,
      subject: ask.success ? ask.data.subject : 'Message'
    })
  }
}

/** Names and subjects from another machine stay one line, so none reads as this computer's own text. */
function plainSender(sender: PeerMailSender | undefined): PeerMailSender | undefined {
  return (
    sender && {
      ...sender,
      name: sender.name === null ? null : toSafeDisplayLine(sender.name),
      computer: toSafeDisplayLine(sender.computer),
      ...(sender.bot ? { bot: { ...sender.bot, name: toSafeDisplayLine(sender.bot.name) } } : {})
    }
  )
}

function plain<T extends { senderLabel: string; subject: string; sender?: PeerMailSender }>(
  mail: T
): T {
  const sender = plainSender(mail.sender)
  return {
    ...mail,
    senderLabel: toSafeDisplayLine(mail.senderLabel) || 'Agent',
    subject: toSafeDisplayLine(mail.subject),
    ...(sender ? { sender } : {})
  }
}

/** A conversation this computer already keeps for this server under this pairing. */
function knownConversation(db: OrchestrationDb, asks: PairedServerAsks, conversationId: string) {
  const conversation = db.getPeerMailConversation(conversationId)
  return conversation?.role === 'peer' &&
    conversation.environment_id === asks.environmentId &&
    conversation.peer_fingerprint === asks.pairing
    ? conversation
    : undefined
}

/** Whether the agent `to` names took part in the conversation: mail a person or an allowance admitted
 *  to it there. A decline, a withdraw or a held card names an agent without admitting anything. */
function tookPart(db: OrchestrationDb, conversationId: string, to: string): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM peer_mail_messages p JOIN messages m ON m.id = p.message_id
         WHERE p.conversation_id = ? AND m.to_handle = ? LIMIT 1`
      )
      .get(conversationId, to) !== undefined
  )
}

/** The conversation the server opened for its agents' asks, as this computer keeps it. */
function openReversedConversation(
  db: OrchestrationDb,
  asks: PairedServerAsks,
  conversationId: string
): void {
  db.assertPeerMailConversation(conversationId, asks.pairing)
  if (!db.getPeerMailConversation(conversationId)) {
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', ?, ?)`
      )
      .run(conversationId, asks.pairing, asks.environmentId)
  }
}

function decideAsk(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  asks: PairedServerAsks,
  item: PulledItem,
  ask: z.infer<typeof ClientAskPayload>
): void {
  const name = parseBotAddress(ask.to)
  const bot = name ? botOfAddress(runtime.bots.list(), name) : null
  const row = {
    message_id: item.messageId,
    conversation_id: item.conversationId,
    server_key: asks.serverKey,
    environment_id: asks.environmentId,
    root_session: ask.rootSession,
    payload: JSON.stringify(ask)
  }
  if (bot && isServerAllowed(db, asks.serverKey, bot.id)) {
    holdPairedServerAsk(db, { ...row, bot_id: bot.id, state: 'admit' })
  } else if (
    bot &&
    (isIntroduced(db, asks.serverKey, ask.rootSession, bot.id) ||
      // Allowed once and removed since: the server asks through a card again, from any chat.
      isServerKnown(db, asks.serverKey, bot.id))
  ) {
    holdPairedServerAsk(db, { ...row, bot_id: bot.id, state: 'card' })
    notifyPairedServerCardsChanged(runtime, [bot.id])
  } else {
    declinePairedServerAsk(runtime, db, {
      conversationId: item.conversationId,
      messageId: item.messageId,
      to: ask.to,
      subject: ask.subject
    })
  }
}

/** Imports one item; a replay changes nothing. Returns whether a card now waits for a person. */
export async function importPairedServerItem(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  asks: PairedServerAsks,
  item: PulledItem
): Promise<{ card: boolean }> {
  // The relay keys replies by conversation, so any other id could name a dispatch's queued reports.
  if (!isGeneratedId(item.conversationId, 'peerconv')) {
    console.warn(
      `[orchestration] Dropped ${item.messageId} from a paired server: it names no conversation`
    )
    return { card: false }
  }
  const json = safeJson(item.payload)
  if (item.kind === 'client_ask_withdraw') {
    const withdrawn = Withdrawn.safeParse(json)
    const card = withdrawn.success ? getPairedServerAsk(db, withdrawn.data.requestId) : undefined
    // Only the server and conversation that sent it can take it back.
    if (
      card &&
      card.environment_id === asks.environmentId &&
      card.conversation_id === item.conversationId &&
      dropPairedServerAsk(db, card.message_id, 'card')
    ) {
      notifyPairedServerCardsChanged(runtime, [card.bot_id])
    }
    return { card: false }
  }
  if (item.kind === 'client_reply') {
    const reply = ClientReplyPayload.safeParse(json)
    if (reply.success && knownConversation(db, asks, item.conversationId)) {
      // A reply on a conversation an agent here took part in goes to that agent with no consent step.
      const data = plain(reply.data)
      await storePeerMailForAgent(
        runtime,
        {
          conversationId: item.conversationId,
          messageId: item.messageId,
          senderLabel: data.senderLabel,
          subject: data.subject,
          threadId: data.threadId ?? undefined,
          to: data.to,
          body: data.body,
          peerFingerprint: asks.pairing,
          environmentId: asks.environmentId,
          senderSnapshot: peerMailSenderSnapshot(data.senderLabel, data.sender),
          admits: (to) => tookPart(db, item.conversationId, to)
        },
        () => (db.getPeerMailMessage(item.messageId) ? true : null)
      )
    } else {
      console.warn(
        `[orchestration] Dropped reply ${item.messageId} from a paired server: no ask here opened its conversation`
      )
    }
    return { card: false }
  }
  const ask = ClientAskPayload.safeParse(json)
  if (!ask.success) {
    console.warn(`[orchestration] Dropped an unreadable ask ${item.messageId} from a paired server`)
    return { card: false }
  }
  // Already decided: held, admitted, or declined (its notice is queued under its id).
  if (
    db.getPeerMailMessage(item.messageId) ||
    isHeld(db, item.messageId) ||
    isDeclined(db, item.conversationId, item.messageId)
  ) {
    return { card: false }
  }
  openReversedConversation(db, asks, item.conversationId)
  decideAsk(runtime, db, asks, item, plain(ask.data))
  return { card: isHeld(db, item.messageId, 'card') }
}

function isHeld(db: OrchestrationDb, messageId: string, state?: 'card'): boolean {
  return (
    db.db
      .prepare(
        'SELECT 1 FROM paired_server_asks WHERE message_id = ? AND (?2 IS NULL OR state = ?2)'
      )
      .get(messageId, state ?? null) !== undefined
  )
}

export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
