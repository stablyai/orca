// Asks and replies this Orca's agents send agents on a paired computer wait in the relay queue
// (`to_worker` on this Orca's home conversation) until that computer pulls them; it acknowledges
// what it took. When the pairing they were sent under ends, their askers are told once.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { tellUnpairedPeerQuestions } from '../peer-mail/peer-questions-out'
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
