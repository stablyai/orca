import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { generateId } from '../generated-id'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'
import type { OrchestrationDb } from '../orchestration-db'
import { writtenRow } from './written-row'
import { escalateWorkerFailure } from '../../workers/reports/worker-failure-escalation'

export type RemoteRunLinkRow = {
  conversation_id: string
  run_id: string
  environment_id: string
  peer_fingerprint: string
  home_fingerprint: string
  pairing_revision: number | null
  peer_run_id: string | null
  state: 'open' | 'cancel_owed' | 'closed'
  cancel_key: string | null
  cancel_attempt: number
  cancel_retries: number
  cancel_retry_at: number | null
  last_imported_sequence: number
  last_error: string | null
  server_name: string | null
  created_at: string
}

/** The pairing a link was made under: the server's host key, this Orca's credential there, and the re-pair generation. */
export type RemoteServerPin = Pick<
  RemoteRunLinkRow,
  'environment_id' | 'peer_fingerprint' | 'home_fingerprint' | 'pairing_revision'
>

export function remoteServerPin(server: OrchestrationWorkerServer): RemoteServerPin {
  return {
    environment_id: server.environmentId,
    peer_fingerprint: server.peerFingerprint,
    home_fingerprint: server.homePeerFingerprint ?? server.peerFingerprint,
    pairing_revision: server.pairingRevision ?? null
  }
}

/** A re-made pairing reaches a different identity on the server, which owns none of this link's work. */
export function remoteRunLinkPinMatches(link: RemoteServerPin, server: RemoteServerPin): boolean {
  return (
    link.environment_id === server.environment_id &&
    link.peer_fingerprint === server.peer_fingerprint &&
    link.home_fingerprint === server.home_fingerprint &&
    link.pairing_revision === server.pairing_revision
  )
}

export function getRemoteRunLink(
  db: OrchestrationDb,
  conversationId: string
): RemoteRunLinkRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare('SELECT * FROM remote_run_links WHERE conversation_id = ?')
    .get(conversationId) as RemoteRunLinkRow | undefined
}

/** The link a write about this Run's remote work may still land under; a reset or re-pair since then closed it. */
export function getOpenRemoteRunLink(
  db: OrchestrationDb,
  conversationId: string
): RemoteRunLinkRow | undefined {
  const link = getRemoteRunLink(db, conversationId)
  return link?.state === 'open' ? link : undefined
}

/** Written before the first command about the Run reaches the server, so its queue always has a reader here. */
export function openRemoteRunLink(
  db: OrchestrationDb,
  runId: string,
  server: OrchestrationWorkerServer,
  notify?: (handle: string, messageType: string) => void
): RemoteRunLinkRow {
  const pin = remoteServerPin(server)
  const transaction = beginLifecycleWriteTransaction(db.db, 'open_remote_run_link')
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
    const open = db.db
      .prepare(
        `SELECT * FROM remote_run_links WHERE run_id = ? AND environment_id = ? AND state = 'open'`
      )
      .get(runId, pin.environment_id) as RemoteRunLinkRow | undefined
    let link = open
    if (open && !remoteRunLinkPinMatches(open, pin)) {
      // Nothing can reach that link's work any more: the server knows this Orca by another pairing now.
      closeRemoteRunLink(
        db,
        open.conversation_id,
        `The pairing with ${server.name} was re-made.`,
        notify
      )
      link = undefined
    }
    if (!link) {
      const conversationId = generateId('peerconv')
      db.db
        .prepare(
          `INSERT INTO remote_run_links (
             conversation_id, run_id, environment_id, peer_fingerprint, home_fingerprint, pairing_revision,
             server_name
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conversationId,
          runId,
          pin.environment_id,
          pin.peer_fingerprint,
          pin.home_fingerprint,
          pin.pairing_revision,
          server.name
        )
      link = getRemoteRunLink(db, conversationId)
    }
    commitLifecycleWriteTransaction(db.db, transaction)
    return writtenRow(link, `Link for Run ${runId}`)
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
  }
}

/** Servers with a link whose queue still needs reading or whose cancel is still owed. */
export function listLiveRemoteRunLinkEnvironments(db: OrchestrationDb): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const rows = db.db
    .prepare(
      `SELECT DISTINCT environment_id FROM remote_run_links WHERE state IN ('open', 'cancel_owed')`
    )
    .all() as { environment_id: string }[]
  return rows.map((row) => row.environment_id)
}

export function listOwedRemoteRunCancels(
  db: OrchestrationDb,
  environmentId: string
): RemoteRunLinkRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare(
      `SELECT * FROM remote_run_links WHERE environment_id = ? AND state = 'cancel_owed' ORDER BY rowid`
    )
    .all(environmentId) as RemoteRunLinkRow[]
}

/** Part of both resets: every open link owes its server a cancel under a fresh key, and keeps its import position as the tombstone. */
export const OWE_REMOTE_RUN_CANCELS_SQL = `
  UPDATE remote_run_links
    SET state = 'cancel_owed', cancel_key = 'cancel:' || lower(hex(randomblob(12))),
        cancel_attempt = 0, cancel_retries = 0, cancel_retry_at = NULL, last_error = NULL
    WHERE state = 'open';
  DELETE FROM remote_placements;
  DELETE FROM remote_dispatches;
  DELETE FROM remote_stop_intents;
  DELETE FROM remote_owned_questions;
`

/**
 * The server can no longer answer for this link's work (its pairing was re-made, or it was removed): nothing more is sent for it, each Task it held fails here
 * through the ordinary Task half with the reason. Its placements stay, holding nothing, so a start
 * there of one of its Tasks is refused here.
 */
export function closeRemoteRunLink(
  db: OrchestrationDb,
  conversationId: string,
  reason: string,
  notify: (handle: string, messageType: string) => void = () => undefined
): void {
  const transaction = beginLifecycleWriteTransaction(db.db, 'close_remote_run_link')
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
    const held = db.db
      .prepare(
        `SELECT placement.task_id, placement.run_id, placement.dispatch_id FROM remote_placements placement
         JOIN tasks task ON task.id = placement.task_id
         WHERE placement.conversation_id = ? AND task.status = 'dispatched'`
      )
      .all(conversationId) as { task_id: string; run_id: string; dispatch_id: string | null }[]
    const now = new Date().toISOString()
    const result = `${reason} Its worker may still run there.`
    for (const placement of held) {
      transitionLifecycleWithDb(db.db, {
        entity: 'task',
        id: placement.task_id,
        from: 'dispatched',
        to: 'failed',
        projection: { result, completed_at: now }
      })
      // As a local worker's failure is: the Run's coordinator is told.
      const dispatchId = placement.dispatch_id ?? placement.task_id
      escalateWorkerFailure(
        db,
        { id: dispatchId, run_id: placement.run_id, task_id: placement.task_id },
        {
          id: `msg_unlinked_${conversationId}_${placement.task_id}`,
          from: `dispatch:${dispatchId}`,
          describe: (task) => ({
            subject: 'Worker unreachable: its server no longer answers here',
            body: `Task ${task} failed here: ${result}`
          }),
          payload: { taskId: placement.task_id, dispatchId: placement.dispatch_id }
        },
        notify
      )
    }
    db.db
      .prepare(
        `UPDATE remote_run_links SET state = 'closed', last_error = ?
         WHERE conversation_id = ? AND state <> 'closed'`
      )
      .run(reason, conversationId)
    // Nothing there can prove a stop now, and nothing here may send one.
    db.db
      .prepare(
        `UPDATE remote_dispatches SET stop_owed = 0, stop_retry_at = NULL WHERE conversation_id = ?`
      )
      .run(conversationId)
    commitLifecycleWriteTransaction(db.db, transaction)
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
  }
}

/** Every open link to this server made under an earlier pairing: none of their work answers here now. */
export function closeRemoteRunLinksOfChangedPairing(
  db: OrchestrationDb,
  server: RemoteServerPin,
  serverName: string,
  notify: (handle: string, messageType: string) => void
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  const links = db.db
    .prepare(`SELECT * FROM remote_run_links WHERE environment_id = ? AND state = 'open'`)
    .all(server.environment_id) as RemoteRunLinkRow[]
  for (const link of links) {
    if (!remoteRunLinkPinMatches(link, server)) {
      closeRemoteRunLink(
        db,
        link.conversation_id,
        `The pairing with ${serverName} was re-made.`,
        notify
      )
    }
  }
}

/** Every link to a server this Orca no longer pairs with: none of their work can be reached again. */
export function closeRemoteRunLinksOfRemovedServer(
  db: OrchestrationDb,
  environmentId: string,
  reason: string,
  notify: (handle: string, messageType: string) => void
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
  const links = db.db
    .prepare(
      `SELECT conversation_id FROM remote_run_links WHERE environment_id = ? AND state <> 'closed'`
    )
    .all(environmentId) as { conversation_id: string }[]
  for (const link of links) {
    closeRemoteRunLink(db, link.conversation_id, reason, notify)
  }
}

/** Why the link's queue stopped being read; shown with the link, cleared by its next import. */
export function noteRemoteRunLinkError(
  db: OrchestrationDb,
  conversationId: string,
  error: unknown
): void {
  db.db
    .prepare('UPDATE remote_run_links SET last_error = ? WHERE conversation_id = ?')
    .run(error instanceof Error ? error.message : String(error), conversationId)
}

/** The server answers again: every stop and cancel owed to it is due now instead of after its backoff. */
export function dueRemoteResendsNow(db: OrchestrationDb, environmentId: string): void {
  db.db
    .prepare(
      `UPDATE remote_dispatches SET stop_retry_at = NULL WHERE environment_id = ? AND stop_owed = 1`
    )
    .run(environmentId)
  db.db
    .prepare(
      `UPDATE remote_run_links SET cancel_retry_at = NULL
       WHERE environment_id = ? AND state = 'cancel_owed'`
    )
    .run(environmentId)
}
