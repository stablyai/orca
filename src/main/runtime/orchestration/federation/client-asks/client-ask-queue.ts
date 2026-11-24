// Asks and replies this Orca's agents send agents on a paired computer wait in the relay queue
// (`to_worker` on this Orca's home conversation) until that computer pulls them; it acknowledges
// what it took. When the pairing they were sent under ends, their askers are told once.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { forgetPeerQuestionOut, tellUnpairedPeerQuestions } from '../peer-mail/peer-questions-out'
import { notifyPeerMailQueued } from '../peer-mail/peer-mail-waiters'
import {
  clientDeviceEnvironmentPattern,
  clientEnvironmentParts,
  CLIENT_ENVIRONMENT_PREFIX
} from './client-ask-environment'
import { forgetClientAskDevice } from './client-ask-listeners'
import {
  clientPairingScopeSql,
  listUnsettledClientPairings,
  markClientPairingsSettled,
  pairedDeviceCredential,
  recordEndedClientPairings,
  type ClientPairingScope
} from './client-ask-ended-pairings'
import { peerMailLocalRecipient } from '../peer-mail/peer-mail-delivery'
import { resolveBareOrchestrationRecipient } from '../../../rpc/methods/orchestration/messaging/recipient-routing'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { ClientReplyPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

function queuedReply(payload: unknown): { subject: string; threadId?: string | null } | undefined {
  try {
    return ClientReplyPayload.safeParse(JSON.parse(String(payload))).data
  } catch {
    return undefined
  }
}

export type ClientItemKind = 'client_ask' | 'client_reply' | 'client_ask_withdraw'

export function queueClientItem(
  db: OrchestrationDb,
  item: { conversationId: string; messageId: string; kind: ClientItemKind; payload: unknown }
): void {
  db.enqueueFederationRelay({
    dispatchId: item.conversationId,
    direction: 'to_worker',
    kind: item.kind,
    messageId: item.messageId,
    payload: JSON.stringify(item.payload)
  })
  notifyPeerMailQueued(db.db)
}

/** A reply this Orca's agent queued there under an ended pairing will never be taken: its sender,
 *  the agent the conversation is with, hears so once, by the reply's thread. A reply the computer
 *  took whose acknowledgment never arrived may have reached it, so the notice says only what this
 *  Orca knows. Runs inside the pairing's ending write; returns the notices, to announce after it. */
function tellDroppedReplies(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  params: { environmentId: string; scope: ClientPairingScope; serverName: string; reason: string }
): MessageRow[] {
  const told: MessageRow[] = []
  const dropped = db.db
    .prepare(
      `SELECT i.dispatch_id, i.message_id, i.payload FROM federation_relay_items i
       JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
       WHERE i.direction = 'to_worker' AND i.kind = 'client_reply' AND i.acked_at IS NULL
         AND c.role = 'home' AND c.environment_id = ?1 AND ${clientPairingScopeSql('c.peer_fingerprint')}`
    )
    .all(params.environmentId, params.scope.keep ?? null, params.scope.only ?? null)
  for (const row of dropped) {
    const conversation = db.getPeerMailConversation(String(row.dispatch_id))
    if (!conversation) {
      continue
    }
    const id = String(row.message_id)
    const reply = queuedReply(row.payload)
    const handle = peerMailLocalRecipient(runtime, conversation)
    const recipient = resolveBareOrchestrationRecipient({ runtime, db, handle })
    const settled = db.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = datetime('now')
         WHERE dispatch_id = ? AND direction = 'to_worker' AND message_id = ? AND acked_at IS NULL`
      )
      .run(conversation.conversation_id, id).changes
    if (settled > 0) {
      told.push(
        db.insertMessage({
          from: params.serverName,
          to: recipient.ok ? recipient.to : handle,
          subject: reply?.subject ?? 'Re: Reply',
          body: `${params.reason} Your reply ${id} there was never confirmed as taken, and it will not be sent again.`,
          threadId: reply?.threadId ?? undefined,
          runId: recipient.ok ? recipient.runId : undefined
        })
      )
    }
  }
  return told
}

/** What that computer hasn't taken under an ended pairing will never be taken. */
function dropQueuedClientItems(
  db: OrchestrationDb,
  environmentId: string,
  scope: ClientPairingScope
): void {
  db.db
    .prepare(
      `UPDATE federation_relay_items SET acked_at = datetime('now')
       WHERE direction = 'to_worker' AND acked_at IS NULL AND dispatch_id IN (
         SELECT conversation_id FROM peer_mail_conversations
         WHERE role = 'home' AND environment_id = ?1 AND ${clientPairingScopeSql('peer_fingerprint')})`
    )
    .run(environmentId, scope.keep ?? null, scope.only ?? null)
}

function endClientPairings(
  runtime: OrcaRuntimeService,
  environmentIds: readonly string[],
  serverName: string,
  reason: string,
  // Which of each environment's pairings end; none named: every one.
  scope: ClientPairingScope = {}
): void {
  const db = runtime.getOrchestrationDb()
  // First, and durably: from here on a reply on one of these conversations is refused, after a
  // restart too, and an ending that fails part way below is finished then (see
  // `replayUnsettledClientPairingEnds`).
  for (const environmentId of environmentIds) {
    recordEndedClientPairings(db, environmentId, scope, { serverName, reason })
  }
  for (const environmentId of environmentIds) {
    tellUnpairedPeerQuestions(runtime, db, {
      environmentId,
      serverName,
      reason,
      ...(scope.keep ? { currentPairing: scope.keep } : {}),
      ...(scope.only ? { onlyPairing: scope.only } : {})
    })
    // A lost reply's notice and the rest dropped, in one write.
    const told = runLifecycleWriteTransaction(db.db, 'client_pairing_ended', () => {
      const notices = tellDroppedReplies(runtime, db, { environmentId, scope, serverName, reason })
      dropQueuedClientItems(db, environmentId, scope)
      markClientPairingsSettled(db, environmentId, scope)
      return notices
    })
    for (const message of told) {
      runtime.notifyMessageArrived(message.to_handle, message.type)
    }
  }
}

/** The computer says it was paired here before under `previousPairing`: what it was sent then is
 *  lost with that pairing. Only the conversations of that fingerprint and installation are touched,
 *  so two computers sharing a copied installation id never end each other's. */
export function settleReplacedClientPairing(
  runtime: OrcaRuntimeService,
  params: {
    previousPairing: string
    currentFingerprint: string
    installationId: string
    name: string
  }
): void {
  if (params.previousPairing === params.currentFingerprint) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const suffix = `/${params.installationId}`
  const environmentIds = db.db
    .prepare(
      `SELECT DISTINCT environment_id FROM peer_mail_conversations
       WHERE role = 'home' AND peer_fingerprint = ? AND environment_id LIKE ?`
    )
    .all(params.previousPairing, `${CLIENT_ENVIRONMENT_PREFIX}%`)
    .map((row) => String(row.environment_id))
    .filter((id) => id.endsWith(suffix))
  endClientPairings(
    runtime,
    environmentIds,
    params.name,
    `The pairing with ${params.name} was re-made.`,
    // Only the pairing it names: another this computer still pulls with keeps its mail.
    { only: params.previousPairing }
  )
}

/** Before a paired computer's device is removed: its pairings' end is recorded first, durably, so a
 *  crash or failure between the revoke and telling its askers is finished at the next start. A
 *  failure is logged, never thrown: it must not stop the revoke. */
export function recordRemovedPairedClient(
  runtime: OrcaRuntimeService,
  device: { deviceId: string; name: string }
): void {
  try {
    const db = runtime.getOrchestrationDb()
    const told = { serverName: device.name, reason: removedReason(device.name) }
    for (const environmentId of clientDeviceEnvironments(db, device.deviceId)) {
      recordEndedClientPairings(db, environmentId, {}, told)
    }
  } catch (error) {
    console.warn('[orchestration] Recording a removed paired computer failed:', error)
  }
}

/** At start: an ending whose askers or queue were never settled is finished, once the device
 *  registry shows it ended (the device is gone or holds another credential). One the registry still
 *  holds is left alone: its revoke never happened, and its next pull revives it. Idempotent: what
 *  was told or dropped already is not again. A failure is logged; the next start tries again. */
export function replayUnsettledClientPairingEnds(runtime: OrcaRuntimeService): void {
  try {
    // A profile with no database yet ended no pairing: nothing to open for.
    const db = runtime.getExistingOrchestrationDb()
    for (const ended of db ? listUnsettledClientPairings(db) : []) {
      const deviceId = clientEnvironmentParts(ended.environmentId)?.deviceId
      const held = deviceId ? pairedDeviceCredential(runtime, deviceId) : undefined
      if (held === undefined || held === ended.pairing) {
        continue
      }
      endClientPairings(runtime, [ended.environmentId], ended.serverName, ended.reason, {
        only: ended.pairing
      })
    }
  } catch (error) {
    console.warn('[orchestration] Finishing an interrupted paired-computer removal failed:', error)
  }
}

function removedReason(name: string): string {
  return `${name} was removed from this Orca's paired computers.`
}

function clientDeviceEnvironments(db: OrchestrationDb, deviceId: string): string[] {
  return db.db
    .prepare(
      `SELECT DISTINCT environment_id FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id LIKE ? ESCAPE '\\'`
    )
    .all(clientDeviceEnvironmentPattern(deviceId))
    .map((row) => String(row.environment_id))
}

/** A paired computer's device was removed here: its askers are told, and it stops listening. A
 *  failure is logged, never thrown: the revoke itself already happened, and its recorded end is
 *  finished at the next start. */
export function settleRemovedPairedClient(
  runtime: OrcaRuntimeService,
  device: { deviceId: string; name: string }
): void {
  try {
    settleRemovedClientDevice(runtime, device)
  } catch (error) {
    console.warn('[orchestration] Telling askers about a removed paired computer failed:', error)
  }
}

function settleRemovedClientDevice(
  runtime: OrcaRuntimeService,
  device: { deviceId: string; name: string }
): void {
  forgetClientAskDevice(runtime, device.deviceId)
  const db = runtime.getOrchestrationDb()
  endClientPairings(
    runtime,
    clientDeviceEnvironments(db, device.deviceId),
    device.name,
    removedReason(device.name)
  )
}

/** A chat that asked agents on paired computers was deleted: asks not taken yet are dropped, and
 *  each one taken is withdrawn there, so a card waiting for a person goes. Its questions are
 *  forgotten, since no one is left to tell. A failure is logged, never thrown: the chat is gone. */
export function withdrawClientAsksOf(runtime: OrcaRuntimeService, askers: readonly string[]): void {
  try {
    const db = runtime.getOrchestrationDb()
    for (const asker of askers) {
      const conversations = db.db
        .prepare(
          `SELECT conversation_id FROM peer_mail_conversations
           WHERE role = 'home' AND local_party = ? AND environment_id LIKE ?`
        )
        .all(asker, `${CLIENT_ENVIRONMENT_PREFIX}%`)
        .map((row) => String(row.conversation_id))
      for (const conversationId of conversations) {
        withdrawConversationAsks(db, conversationId)
      }
    }
  } catch (error) {
    console.warn("[orchestration] Withdrawing a deleted chat's asks failed:", error)
  }
}

function withdrawConversationAsks(db: OrchestrationDb, conversationId: string): void {
  const asks = db.db
    .prepare(
      `SELECT message_id, acked_at FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = 'to_worker' AND kind = 'client_ask'`
    )
    .all(conversationId)
  for (const ask of asks) {
    const messageId = String(ask.message_id)
    forgetPeerQuestionOut(db, messageId)
    if (ask.acked_at === null) {
      db.db
        .prepare(
          `UPDATE federation_relay_items SET acked_at = datetime('now')
           WHERE dispatch_id = ? AND direction = 'to_worker' AND message_id = ?`
        )
        .run(conversationId, messageId)
      continue
    }
    // A stable id, so a second deletion pass queues nothing new.
    queueClientItem(db, {
      conversationId,
      messageId: `withdraw:${messageId}`,
      kind: 'client_ask_withdraw',
      payload: { requestId: messageId }
    })
  }
}
