import type Database from '../../../sqlite/sync-database'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL } from './pane-key-match'

/**
 * The only place that inserts rows representing a live supervised worker.
 *
 * Why centralized: nesting depth must be stamped on every such row, and three
 * separate modules used to own their own INSERT. A boundary test forbids these
 * statements anywhere else, so a new spawn path cannot skip the stamp.
 *
 * Transaction-neutral on purpose — each caller keeps its own BEGIN IMMEDIATE or
 * SAVEPOINT, mutation-receipt write, and companion inserts.
 */

export const DISPATCH_CONTEXT_CLAIM_SQL = `INSERT INTO dispatch_contexts (
  id, run_id, task_id, contract_version, launch_token_hash,
  assignee_handle, assignee_pane_key, process_incarnation,
  status, failure_count, depth, dispatched_at
)
SELECT ?, run_id, id, ?, ?, ?, ?, ?, 'dispatched', ?, ?, datetime('now')
FROM tasks
WHERE id = ? AND status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_contexts active
    WHERE active.assignee_handle = ?
      AND active.status IN ('pending', 'dispatched')
  )
  AND (
    ? IS NULL OR NOT EXISTS (
      SELECT 1 FROM dispatch_contexts active
      WHERE active.assignee_pane_key = ?
        AND active.status IN ('pending', 'dispatched')
    )
  )
  AND (
    ? IS NULL OR NOT EXISTS (
      SELECT 1 FROM dispatch_contexts active
      WHERE active.assignee_pane_key IS NOT NULL
        AND active.status IN ('pending', 'dispatched')
        AND instr(active.assignee_pane_key, ':') > 1
        AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
    )
  )`

const STARTING_DISPATCH_CONTEXT_SQL = `INSERT INTO dispatch_contexts (
   id, run_id, task_id, contract_version, launch_token_hash, depth, status, dispatched_at
 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`

const REMOTE_DISPATCH_ATTACHMENT_SQL = `INSERT INTO remote_dispatch_attachments (
   dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch, depth
 ) VALUES (?, ?, ?, ?, ?, ?)`

/** Last line of defence: a row that reached here unstamped would read as a root. */
function assertStampedDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(
      `Refusing to write a live-worker row with depth ${depth}; expected an integer >= 1.`
    )
  }
}

/** Adopts an existing agent terminal, claiming a ready task atomically. */
export function claimDispatchContextRow(
  db: Database.Database,
  params: {
    id: string
    contractVersion: number
    launchTokenHash: string | null
    assigneeHandle: string
    assigneePaneKey: string | null
    processIncarnation: string | null
    priorFailures: number
    depth: number
    taskId: string
    paneSuffix: string | null
  }
): { changes: number | bigint } {
  assertStampedDepth(params.depth)
  return db
    .prepare(DISPATCH_CONTEXT_CLAIM_SQL)
    .run(
      params.id,
      params.contractVersion,
      params.launchTokenHash,
      params.assigneeHandle,
      params.assigneePaneKey,
      params.processIncarnation,
      params.priorFailures,
      params.depth,
      params.taskId,
      params.assigneeHandle,
      params.assigneePaneKey,
      params.assigneePaneKey,
      params.paneSuffix,
      params.paneSuffix
    )
}

/** Supervised `worker-start`, including every retry and the federated home side. */
export function insertStartingDispatchContextRow(
  db: Database.Database,
  params: {
    id: string
    runId: string
    taskId: string
    contractVersion: number
    launchTokenHash: string | null
    depth: number
  }
): void {
  assertStampedDepth(params.depth)
  db.prepare(STARTING_DISPATCH_CONTEXT_SQL).run(
    params.id,
    params.runId,
    params.taskId,
    params.contractVersion,
    params.launchTokenHash,
    params.depth
  )
}

/** The worker host's record of a live worker driven by a remote Run home. */
export function insertRemoteDispatchAttachmentRow(
  db: Database.Database,
  params: {
    dispatchId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    /** Propagated from the Run home, not computed here; absent (old client) = 1. */
    depth: number
  }
): void {
  assertStampedDepth(params.depth)
  db.prepare(REMOTE_DISPATCH_ATTACHMENT_SQL).run(
    params.dispatchId,
    params.taskId,
    params.homePeerFingerprint,
    params.protocolVersion,
    params.runtimeEpoch,
    params.depth
  )
}
