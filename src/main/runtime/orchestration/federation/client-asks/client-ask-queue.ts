// Asks and replies this Orca's agents send agents on a paired computer wait in the relay queue
// (`to_worker` on this Orca's home conversation) until that computer pulls them; it acknowledges
// what it took. When the pairing they were sent under ends, their askers are told once.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { forgetPeerQuestionOut, tellUnpairedPeerQuestions } from '../peer-mail/peer-questions-out'
import { notifyPeerMailQueued } from '../peer-mail/peer-mail-waiters'
import { clientDeviceEnvironmentPattern, CLIENT_ENVIRONMENT_PREFIX } from './client-ask-environment'
import { forgetClientAskDevice } from './client-ask-listeners'

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

/** What that computer hasn't taken under an ended pairing will never be taken. */
function dropQueuedClientItems(
  db: OrchestrationDb,
  environmentId: string,
  currentPairing: string | null
): void {
  db.db
    .prepare(
      `UPDATE federation_relay_items SET acked_at = datetime('now')
       WHERE direction = 'to_worker' AND acked_at IS NULL AND dispatch_id IN (
         SELECT conversation_id FROM peer_mail_conversations
         WHERE role = 'home' AND environment_id = ?1 AND (?2 IS NULL OR peer_fingerprint <> ?2))`
    )
    .run(environmentId, currentPairing)
}

function endClientPairings(
  runtime: OrcaRuntimeService,
  environmentIds: readonly string[],
  serverName: string,
  reason: string,
  // Kept when the computer still pulls under it: only older pairings' mail is lost.
  currentPairing: string | null = null
): void {
  const db = runtime.getOrchestrationDb()
  for (const environmentId of environmentIds) {
    tellUnpairedPeerQuestions(runtime, db, {
      environmentId,
      serverName,
      reason,
      ...(currentPairing ? { currentPairing } : {})
    })
    dropQueuedClientItems(db, environmentId, currentPairing)
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
    params.currentFingerprint
  )
}

/** A paired computer's device was removed here: its askers are told, and it stops listening. A
 *  failure is logged, never thrown: the revoke itself already happened. */
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
  const environmentIds = db.db
    .prepare(
      `SELECT DISTINCT environment_id FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id LIKE ? ESCAPE '\\'`
    )
    .all(clientDeviceEnvironmentPattern(device.deviceId))
    .map((row) => String(row.environment_id))
  endClientPairings(
    runtime,
    environmentIds,
    device.name,
    `${device.name} was removed from this Orca's paired computers.`
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
