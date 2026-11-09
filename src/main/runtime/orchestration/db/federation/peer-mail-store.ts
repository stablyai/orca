import type { MessageRow } from '../orchestration-records'
import type { MessageInsert } from '../messages/message-insert'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type PeerMailConversationRow = {
  conversation_id: string
  role: 'home' | 'peer'
  environment_id: string | null
  peer_fingerprint: string
  local_party: string | null
  local_pane_key: string | null
  created_at: string
}

export type PeerMailMessageRow = {
  message_id: string
  conversation_id: string
  sender_label: string
  remote_party: string | null
}

/** The conversation this Orca opened for one local agent with one paired server; reused for every send. */
export function openHomePeerMailConversation(
  this: OrchestrationDb,
  params: {
    environmentId: string
    peerFingerprint: string
    localParty: string
    localPaneKey: string | null
  }
): PeerMailConversationRow {
  this.db
    .prepare(
      `INSERT INTO peer_mail_conversations (
         conversation_id, role, environment_id, peer_fingerprint, local_party, local_pane_key
       ) VALUES (?, 'home', ?, ?, ?, ?)
       ON CONFLICT(environment_id, local_party) WHERE role = 'home'
       DO UPDATE SET peer_fingerprint = excluded.peer_fingerprint,
                     local_pane_key = COALESCE(excluded.local_pane_key, local_pane_key)`
    )
    .run(
      generateId('peerconv'),
      params.environmentId,
      params.peerFingerprint,
      params.localParty,
      params.localPaneKey
    )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly its row shape.
  return this.db
    .prepare(
      `SELECT * FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id = ? AND local_party = ?`
    )
    .get(params.environmentId, params.localParty) as PeerMailConversationRow
}

export function getPeerMailConversation(
  this: OrchestrationDb,
  conversationId: string
): PeerMailConversationRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly its row shape.
  return this.db
    .prepare('SELECT * FROM peer_mail_conversations WHERE conversation_id = ?')
    .get(conversationId) as PeerMailConversationRow | undefined
}

export function listHomePeerMailEnvironments(this: OrchestrationDb): string[] {
  const statement = this.db.prepare(
    `SELECT DISTINCT environment_id FROM peer_mail_conversations
     WHERE role = 'home' AND environment_id IS NOT NULL`
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const rows = statement.all() as { environment_id: string }[]
  return rows.map((row) => row.environment_id)
}

export function listPeerConversationIds(this: OrchestrationDb, peerFingerprint: string): string[] {
  const statement = this.db.prepare(
    `SELECT conversation_id FROM peer_mail_conversations
     WHERE role = 'peer' AND peer_fingerprint = ?`
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const rows = statement.all(peerFingerprint) as { conversation_id: string }[]
  return rows.map((row) => row.conversation_id)
}

export function getPeerMailMessage(
  this: OrchestrationDb,
  messageId: string
): PeerMailMessageRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly its row shape.
  return this.db.prepare('SELECT * FROM peer_mail_messages WHERE message_id = ?').get(messageId) as
    | PeerMailMessageRow
    | undefined
}

export function isPeerMailSenderLabel(this: OrchestrationDb, label: string): boolean {
  return (
    this.db
      .prepare('SELECT 1 FROM peer_mail_messages WHERE sender_label = ? LIMIT 1')
      .get(label) !== undefined
  )
}

/** Stores mail that crossed from a paired Orca once; a replayed id returns the stored row. */
export function insertPeerMailMessage(
  this: OrchestrationDb,
  params: {
    conversationId: string
    /** Only a 'peer' conversation is created here, by the paired Orca that opened it. */
    peerFingerprint?: string
    remoteParty: string | null
    message: MessageInsert & { id: string; from: string }
  }
): { message: MessageRow; duplicate: boolean } {
  this.db.exec('SAVEPOINT peer_mail_insert')
  try {
    if (params.peerFingerprint !== undefined) {
      const conversation = this.getPeerMailConversation(params.conversationId)
      if (
        conversation &&
        (conversation.role !== 'peer' || conversation.peer_fingerprint !== params.peerFingerprint)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Conversation ${params.conversationId} belongs to another server. Nothing was delivered.`,
          { effectsApplied: false }
        )
      }
      if (!conversation) {
        this.db
          .prepare(
            `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint)
             VALUES (?, 'peer', ?)`
          )
          .run(params.conversationId, params.peerFingerprint)
      }
    }
    const existing = this.getPeerMailMessage(params.message.id)
    const stored = existing ? this.getMessageById(params.message.id) : undefined
    if (existing && stored) {
      this.db.exec('RELEASE peer_mail_insert')
      return { message: stored, duplicate: true }
    }
    const message = this.insertMessage(params.message)
    this.db
      .prepare(
        `INSERT INTO peer_mail_messages (message_id, conversation_id, sender_label, remote_party)
         VALUES (?, ?, ?, ?)`
      )
      .run(message.id, params.conversationId, params.message.from, params.remoteParty)
    this.db.exec('RELEASE peer_mail_insert')
    return { message, duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK TO peer_mail_insert')
    this.db.exec('RELEASE peer_mail_insert')
    throw error
  }
}

export type PeerMailStoreMethods = {
  openHomePeerMailConversation: typeof openHomePeerMailConversation
  getPeerMailConversation: typeof getPeerMailConversation
  listHomePeerMailEnvironments: typeof listHomePeerMailEnvironments
  listPeerConversationIds: typeof listPeerConversationIds
  getPeerMailMessage: typeof getPeerMailMessage
  isPeerMailSenderLabel: typeof isPeerMailSenderLabel
  insertPeerMailMessage: typeof insertPeerMailMessage
}

export function attachPeerMailStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    openHomePeerMailConversation,
    getPeerMailConversation,
    listHomePeerMailEnvironments,
    listPeerConversationIds,
    getPeerMailMessage,
    isPeerMailSenderLabel,
    insertPeerMailMessage
  })
}
