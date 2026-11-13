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

/** The conversation this Orca opened for one local agent with one paired server's current pairing; reused for every send. */
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
       ON CONFLICT(environment_id, local_party, peer_fingerprint) WHERE role = 'home'
       DO UPDATE SET local_pane_key = COALESCE(excluded.local_pane_key, local_pane_key)`
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
       WHERE role = 'home' AND environment_id = ? AND local_party = ? AND peer_fingerprint = ?`
    )
    .get(params.environmentId, params.localParty, params.peerFingerprint) as PeerMailConversationRow
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

/** One server's check, for its pull loop: a seek on that server's home rows, not every server's. */
export function hasHomePeerMailEnvironment(this: OrchestrationDb, environmentId: string): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM peer_mail_conversations WHERE role = 'home' AND environment_id = ? LIMIT 1`
      )
      .get(environmentId) !== undefined
  )
}

/** Conversations a paired Orca opened here that hold replies it has not acknowledged yet. */
export function listPeerConversationIdsWithPendingReplies(
  this: OrchestrationDb,
  peerFingerprint: string
): string[] {
  const statement = this.db.prepare(
    `SELECT DISTINCT c.conversation_id FROM federation_relay_items i
     JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
     WHERE i.direction = 'to_home' AND i.acked_at IS NULL
       AND c.role = 'peer' AND c.peer_fingerprint = ?
     ORDER BY c.conversation_id`
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

/** Stores mail that crossed from a paired Orca once; a replayed id is a duplicate, even after a reset removed its row. */
export function insertPeerMailMessage(
  this: OrchestrationDb,
  params: {
    conversationId: string
    /** Only a 'peer' conversation is created here, by the paired Orca that opened it. */
    peerFingerprint?: string
    remoteParty: string | null
    message: MessageInsert & { id: string; from: string }
  }
):
  | { message: MessageRow; duplicate: false }
  | { message: MessageRow | undefined; duplicate: true } {
  this.db.exec('SAVEPOINT peer_mail_insert')
  try {
    // A peer Run's conversation keeps its own queue sequence, so it never carries peer mail.
    if (this.getPeerRunForConversation(params.conversationId)) {
      throw new OrchestrationError(
        'request_mismatch',
        `Conversation ${params.conversationId} belongs to a coordinated Run. Nothing was delivered.`,
        { effectsApplied: false }
      )
    }
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
    if (this.getPeerMailMessage(params.message.id)) {
      this.db.exec('RELEASE peer_mail_insert')
      return { message: this.getMessageById(params.message.id), duplicate: true }
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
  hasHomePeerMailEnvironment: typeof hasHomePeerMailEnvironment
  listPeerConversationIdsWithPendingReplies: typeof listPeerConversationIdsWithPendingReplies
  getPeerMailMessage: typeof getPeerMailMessage
  isPeerMailSenderLabel: typeof isPeerMailSenderLabel
  insertPeerMailMessage: typeof insertPeerMailMessage
}

export function attachPeerMailStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    openHomePeerMailConversation,
    getPeerMailConversation,
    listHomePeerMailEnvironments,
    hasHomePeerMailEnvironment,
    listPeerConversationIdsWithPendingReplies,
    getPeerMailMessage,
    isPeerMailSenderLabel,
    insertPeerMailMessage
  })
}
