import type { MessageRow } from '../orchestration-records'
import type { MessageInsert } from '../messages/message-insert'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { NOT_CLIENT_ENVIRONMENT_SQL } from '../../federation/client-asks/client-ask-environment'
import { GROUP_POST_RELAY_KIND } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

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
  group_question: string | null
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
     WHERE role = 'home' AND environment_id IS NOT NULL AND ${NOT_CLIENT_ENVIRONMENT_SQL}`
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const rows = statement.all() as { environment_id: string }[]
  return rows.map((row) => row.environment_id)
}

/** Conversations a paired Orca opened here that hold replies it has not acknowledged yet, and, for a
 *  paired computer that takes asks (`clientEnvironmentId`), this Orca's conversations holding asks for it. */
export function listPeerConversationIdsWithPendingReplies(
  this: OrchestrationDb,
  peerFingerprint: string,
  clientEnvironmentId: string | null = null,
  includeGroupPosts = true
): string[] {
  const statement = this.db.prepare(
    `SELECT DISTINCT c.conversation_id FROM federation_relay_items i
     JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
     WHERE i.acked_at IS NULL AND c.peer_fingerprint = ?1
       AND (?3 OR i.kind <> '${GROUP_POST_RELAY_KIND}')
       AND ((i.direction = 'to_home' AND c.role = 'peer' AND c.environment_id IS NULL)
         OR (?2 IS NOT NULL AND i.direction = 'to_worker' AND c.role = 'home' AND c.environment_id = ?2))
     ORDER BY c.conversation_id`
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const rows = statement.all(peerFingerprint, clientEnvironmentId, Number(includeGroupPosts)) as {
    conversation_id: string
  }[]
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

/** The 'peer' conversation a paired Orca opened, created on its first mail; refused for another server's. */
function openPeerConversation(
  db: OrchestrationDb,
  conversationId: string,
  peerFingerprint: string,
  // Set when the far side is a server this Orca dials: the server opened it for its agents' asks.
  environmentId: string | null = null
): void {
  const conversation = db.getPeerMailConversation(conversationId)
  if (
    conversation &&
    (conversation.role !== 'peer' || conversation.peer_fingerprint !== peerFingerprint)
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Conversation ${conversationId} belongs to another server. Nothing was delivered.`,
      { effectsApplied: false }
    )
  }
  if (!conversation) {
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', ?, ?)`
      )
      .run(conversationId, peerFingerprint, environmentId)
  }
}

/** Refuses, before anything is admitted, a conversation that is a coordinated Run's or another server's. */
export function assertPeerMailConversation(
  this: OrchestrationDb,
  conversationId: string,
  peerFingerprint: string
): void {
  if (this.getPeerRunForConversation(conversationId)) {
    throw new OrchestrationError(
      'request_mismatch',
      `Conversation ${conversationId} belongs to a coordinated Run. Nothing was delivered.`,
      { effectsApplied: false }
    )
  }
  const conversation = this.getPeerMailConversation(conversationId)
  if (
    conversation &&
    (conversation.role !== 'peer' || conversation.peer_fingerprint !== peerFingerprint)
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Conversation ${conversationId} belongs to another server. Nothing was delivered.`,
      { effectsApplied: false }
    )
  }
}

/** Files mail a bot admitted through its own path under the conversation it came on; once per id. */
export function linkPeerMailMessage(
  this: OrchestrationDb,
  params: {
    conversationId: string
    peerFingerprint: string
    messageId: string
    senderLabel: string
    environmentId?: string
    groupQuestion?: string
  }
): void {
  openPeerConversation(this, params.conversationId, params.peerFingerprint, params.environmentId)
  this.db
    .prepare(
      `INSERT OR IGNORE INTO peer_mail_messages (message_id, conversation_id, sender_label, remote_party, group_question)
       VALUES (?, ?, ?, NULL, ?)`
    )
    .run(params.messageId, params.conversationId, params.senderLabel, params.groupQuestion ?? null)
}

/** Stores mail that crossed from a paired Orca once; a replayed id is a duplicate, even after a reset removed its row. */
export function insertPeerMailMessage(
  this: OrchestrationDb,
  params: {
    conversationId: string
    /** Only a 'peer' conversation is created here, by the paired Orca that opened it. */
    peerFingerprint?: string
    /** With `peerFingerprint`: the server this Orca dials that opened it. */
    environmentId?: string
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
      openPeerConversation(
        this,
        params.conversationId,
        params.peerFingerprint,
        params.environmentId
      )
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
  listPeerConversationIdsWithPendingReplies: typeof listPeerConversationIdsWithPendingReplies
  getPeerMailMessage: typeof getPeerMailMessage
  isPeerMailSenderLabel: typeof isPeerMailSenderLabel
  insertPeerMailMessage: typeof insertPeerMailMessage
  assertPeerMailConversation: typeof assertPeerMailConversation
  linkPeerMailMessage: typeof linkPeerMailMessage
}

export function attachPeerMailStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    openHomePeerMailConversation,
    getPeerMailConversation,
    listHomePeerMailEnvironments,
    listPeerConversationIdsWithPendingReplies,
    getPeerMailMessage,
    isPeerMailSenderLabel,
    insertPeerMailMessage,
    assertPeerMailConversation,
    linkPeerMailMessage
  })
}
