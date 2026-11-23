// Whether the pairing a paired computer's conversation here was made under has ended. A
// conversation keeps that pairing: mail never moves to another pairing or device, so once it ended
// a reply there is refused rather than queued for a pairing that will never pull again. Two facts
// end it: this Orca recorded the end (the computer was removed, or said a re-pair replaced it), or
// the device registry no longer holds that device under that credential, which also covers a
// pairing removed before the record existed.
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { ClientAskListenerOwner } from './client-ask-listeners'

export const CLIENT_ASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ended_client_pairings (
  environment_id         TEXT NOT NULL,
  peer_fingerprint       TEXT NOT NULL,
  ended_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (environment_id, peer_fingerprint)
);
-- An ask's card finds the ask it names by its id alone.
CREATE INDEX IF NOT EXISTS idx_federation_relay_client_asks
  ON federation_relay_items(message_id) WHERE kind = 'client_ask';`

/** The credential fingerprint a paired device holds now: null once it was removed, undefined when
 *  there is no registry to tell. */
export type PairedDeviceCredential = (deviceId: string) => string | null | undefined

const credentialsByOwner = new WeakMap<ClientAskListenerOwner, PairedDeviceCredential>()

/** The server that keeps this runtime's device registry names it here when it is made. */
export function registerPairedDeviceCredentials(
  owner: ClientAskListenerOwner,
  credentialOf: PairedDeviceCredential
): void {
  credentialsByOwner.set(owner, credentialOf)
}

/** The pairing's end is recorded for these conversations: all of the environment's but
 *  `scope.keep`, which it still pulls with, or only `scope.only`. */
export function recordEndedClientPairings(
  db: OrchestrationDb,
  environmentId: string,
  scope: ClientPairingScope
): void {
  db.db
    .prepare(
      `INSERT OR IGNORE INTO ended_client_pairings (environment_id, peer_fingerprint)
       SELECT DISTINCT environment_id, peer_fingerprint FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id = ?1 AND ${clientPairingScopeSql('peer_fingerprint')}`
    )
    .run(environmentId, scope.keep ?? null, scope.only ?? null)
}

/** Which pairings of an environment an end touches: all but `keep`, or only `only`; neither: all. */
export type ClientPairingScope = { keep?: string; only?: string }

/** The scope as SQL over `column`, with `?2` keep and `?3` only. */
export function clientPairingScopeSql(column: string): string {
  return `(?2 IS NULL OR ${column} <> ?2) AND (?3 IS NULL OR ${column} = ?3)`
}

/** Whether a conversation's pairing with the computer `deviceId` names has ended. */
export function isEndedClientPairing(
  owner: ClientAskListenerOwner,
  db: OrchestrationDb,
  conversation: { environmentId: string; deviceId: string; pairing: string }
): boolean {
  const held = credentialsByOwner.get(owner)?.(conversation.deviceId)
  if (held !== undefined && held !== conversation.pairing) {
    return true
  }
  return (
    db.db
      .prepare(
        'SELECT 1 FROM ended_client_pairings WHERE environment_id = ? AND peer_fingerprint = ?'
      )
      .get(conversation.environmentId, conversation.pairing) !== undefined
  )
}

/** The computer pulled under that pairing's own credential: it has not ended, whatever a re-pair
 *  claimed. */
export function reviveClientPairing(
  db: OrchestrationDb,
  environmentId: string,
  pairing: string
): void {
  db.db
    .prepare('DELETE FROM ended_client_pairings WHERE environment_id = ? AND peer_fingerprint = ?')
    .run(environmentId, pairing)
}
