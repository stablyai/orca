// What this computer does with an item a paired server queued for it, decided once at import, in
// one write, so a slow admission never holds the pull: an ask its people allowed is admitted after
// the acknowledgment, one they introduced waits for a person, anything else is declined.
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  ClientAskPayload,
  ClientReplyPayload
} from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { botOfAddress, parseBotAddress } from '../../../../../shared/bot-roster'
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

/** Its asker hears "Declined" with no reason: by the reply route, so a question settles by its id.
 *  The notice's id follows the ask's, so a replayed import queues no second one. */
export function declinePairedServerAsk(
  runtime: Pick<OrcaRuntimeService, 'readMachineName'>,
  db: OrchestrationDb,
  ask: { conversationId: string; messageId: string; to: string; subject: string }
): void {
  const noticeId = `${ask.messageId}_declined`
  const queued = db.db
    .prepare(
      `SELECT 1 FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = 'to_home' AND message_id = ?`
    )
    .get(ask.conversationId, noticeId)
  if (queued) {
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
    server_installation_id: asks.serverInstallationId,
    environment_id: asks.environmentId,
    root_session: ask.rootSession,
    payload: item.payload
  }
  if (bot && isServerAllowed(db, asks.serverInstallationId, bot.id)) {
    holdPairedServerAsk(db, { ...row, bot_id: bot.id, state: 'admit' })
  } else if (bot && isIntroduced(db, asks.serverInstallationId, ask.rootSession, bot.id)) {
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
  openReversedConversation(db, asks, item.conversationId)
  const json = safeJson(item.payload)
  if (item.kind === 'client_ask_withdraw') {
    const withdrawn = Withdrawn.safeParse(json)
    const card = withdrawn.success ? getPairedServerAsk(db, withdrawn.data.requestId) : undefined
    if (card && dropPairedServerAsk(db, card.message_id, 'card')) {
      notifyPairedServerCardsChanged(runtime, [card.bot_id])
    }
    return { card: false }
  }
  if (item.kind === 'client_reply') {
    const reply = ClientReplyPayload.safeParse(json)
    if (reply.success) {
      // The conversation exists and is linked, so the agent takes it with no consent step.
      await storePeerMailForAgent(
        runtime,
        {
          conversationId: item.conversationId,
          messageId: item.messageId,
          senderLabel: reply.data.senderLabel,
          subject: reply.data.subject,
          threadId: reply.data.threadId ?? undefined,
          to: reply.data.to,
          body: reply.data.body,
          peerFingerprint: asks.pairing,
          environmentId: asks.environmentId,
          senderSnapshot: peerMailSenderSnapshot(reply.data.senderLabel, reply.data.sender)
        },
        () => (db.getPeerMailMessage(item.messageId) ? true : null)
      )
    }
    return { card: false }
  }
  const ask = ClientAskPayload.safeParse(json)
  if (!ask.success) {
    console.warn(`[orchestration] Dropped an unreadable ask ${item.messageId} from a paired server`)
    return { card: false }
  }
  // Already decided: held, admitted, or declined (its notice is queued under its id's thread).
  if (db.getPeerMailMessage(item.messageId) || isHeld(db, item.messageId)) {
    return { card: false }
  }
  decideAsk(runtime, db, asks, item, ask.data)
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
