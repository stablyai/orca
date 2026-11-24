// Whom a bot conversation with no acts-for record acts for, read from its first message.
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { firstMessageActsFor } from '../../../../../bots/bot-request-asker'
import type { JournalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { botRequestRecord, isPulledServerRequest } from './bot-request-record'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'

/** Whom a conversation Orca has no record for acts for, by its first message; null before any.
 *  `reads` are its /clear root's: a cleared chat reads its root's. Reads only. */
export async function readFirstMessageActsFor(
  db: OrchestrationDb,
  reads: Promise<Pick<JournalSqlReads, 'promptItem'>>,
  workspaceId: string | null
): Promise<BotRequestAsker[] | null> {
  const firstPrompt = await (await reads).promptItem('first')
  return firstMessageActsFor(firstPrompt ? [firstPrompt] : [], {
    botRequestAskers: (messageId) => botRequestRecord(db, messageId)?.askers ?? null,
    conversationWorkspaceId: workspaceId
  })
}

// Bot requests addressed to one chat: a seek on the mailbox index, bounded by that chat's mail.
const REQUESTS_TO_SQL = `SELECT m.id FROM messages m JOIN bot_requests r ON r.message_id = m.id
  WHERE m.to_handle = ?`

// Per database, what each chat root was found to be: its first message never changes, so the
// lookup runs once per chat while Orca runs, not on every action. A failed read is not kept.
const pulledChatsByDb = new WeakMap<OrchestrationDb, Map<string, boolean>>()

/** `isPulledRequestChat`, read once per chat root and database. */
export async function isPulledRequestChatOnce(
  db: OrchestrationDb,
  reads: () => Promise<Pick<JournalSqlReads, 'promptItem'>>,
  root: OrcaSessionId
): Promise<boolean> {
  const known = pulledChatsByDb.get(db) ?? new Map<string, boolean>()
  pulledChatsByDb.set(db, known)
  const cached = known.get(root)
  if (cached !== undefined) {
    return cached
  }
  let settled = true
  const pulled = await isPulledRequestChat(db, reads, root, () => {
    settled = false
  })
  if (settled) {
    known.set(root, pulled)
  }
  return pulled
}

/** Whether a chat was started for a request pulled from a paired server: its first message is that
 *  request, filed under the server's reverse conversation, and addressed to this very chat (`root`,
 *  its /clear root). Earlier versions kept such a chat's acts-for as the owner's; it acts for no
 *  one. A chat that merely received such a request later, or one a person opened, is not one. Its
 *  journal is read only for a chat such a request was addressed to; when that read fails, it is
 *  counted as one, so an unproven chat never keeps the owner's authority. */
export async function isPulledRequestChat(
  db: OrchestrationDb,
  reads: () => Promise<Pick<JournalSqlReads, 'promptItem'>>,
  root: OrcaSessionId,
  onReadFailed: () => void = () => {}
): Promise<boolean> {
  const pulled = new Set(
    db.db
      .prepare(REQUESTS_TO_SQL)
      .all(formatOrcaSessionAddress(root))
      .map((row) => String(row.id))
      .filter((messageId) => isPulledServerRequest(db, messageId))
  )
  if (pulled.size === 0) {
    return false
  }
  try {
    const firstPrompt = await (await reads()).promptItem('first')
    const mail =
      firstPrompt?.body.kind === 'message' ? firstPrompt.body.from?.orchestration : undefined
    return (
      mail?.message === 'mail-notice' &&
      mail.messages.some(({ messageId }) => pulled.has(messageId))
    )
  } catch (error) {
    console.warn('[bots] could not read whether a chat began with a paired server request', error)
    onReadFailed()
    return true
  }
}
