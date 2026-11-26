import type Database from '../../../sqlite/sync-database'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL } from './pane-key-match'
import type { OrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import type { DispatchCreatorTurnSource } from './dispatch-depth'

/** Centralize live-worker inserts to enforce depth; callers retain transactions, receipts and companion writes. */

/** Whom a new Dispatch acts for (JSON, as `bot_conversation_acts_for`), copied once from whoever
 *  makes it: a worker passes on its own Dispatch's stamp, a chat its record; anything else of the
 *  owner's (his terminals, own chats and paired computers) leaves it null, the owner. Bound to the
 *  creator's Dispatch id (twice), then its session id. */
const CREATOR_STAMP_SQL = `CASE
    WHEN ? IS NOT NULL THEN (SELECT stamp.acts_for FROM dispatch_contexts stamp WHERE stamp.id = ?)
    ELSE (SELECT record.acts_for FROM bot_conversation_acts_for record WHERE record.session_id = ?)
  END`

/** A stamp naming only the owner (null, or a record of owners alone), on `creator.stamp`. Every
 *  comparison is NULL-safe (`IS`), so an asker missing its kind or role never reads as the owner, and
 *  the CASE keeps an unreadable stamp (not one, never the owner's) from reaching `json_each`. */
const OWNERS_STAMP_SQL = `(creator.stamp IS NULL OR CASE
    WHEN json_valid(creator.stamp) AND json_type(creator.stamp) IS 'array'
      AND json_array_length(creator.stamp) > 0
    THEN NOT EXISTS (SELECT 1 FROM json_each(creator.stamp) asker
      WHERE NOT (json_extract(asker.value, '$.kind') IS 'owner'
        OR (json_extract(asker.value, '$.kind') IS 'person'
          AND json_extract(asker.value, '$.role') IS 'owner')))
    ELSE 0
  END)`

function creatorStampArgs(params: {
  creatorDispatchId?: string | null
  creatorOrcaSessionId?: OrcaSessionId | null
}): (string | null)[] {
  return [
    params.creatorDispatchId ?? null,
    params.creatorDispatchId ?? null,
    params.creatorOrcaSessionId ?? null
  ]
}

export const DISPATCH_CONTEXT_CLAIM_SQL = `INSERT INTO dispatch_contexts (
  id, run_id, task_id, contract_version, launch_token_hash,
  assignee_handle, assignee_pane_key, assignee_orca_session_id, process_incarnation,
  creator_dispatch_id, creator_handle, creator_pane_key, creator_orca_session_id,
  creator_turn_source, status, failure_count, depth, dispatched_at, acts_for
)
SELECT ?, run_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, datetime('now'),
  ${CREATOR_STAMP_SQL}
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
   id, run_id, task_id, contract_version, launch_token_hash, retry_of_dispatch_id,
   creator_dispatch_id, creator_handle, creator_pane_key, creator_orca_session_id,
   creator_turn_source, depth, status, failure_count, dispatched_at, follow_up_of_dispatch_id,
   origin_ref, for_message_id, chat_lineage, acts_for
 )
 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'), ?, ?, ?, ?,
   -- A retry or follow-up the owner makes keeps the narrower stamp of the worker it continues.
   CASE WHEN ${OWNERS_STAMP_SQL}
     THEN COALESCE((SELECT prior.acts_for FROM dispatch_contexts prior WHERE prior.id = ?), creator.stamp)
     ELSE creator.stamp END
 FROM (SELECT ${CREATOR_STAMP_SQL} AS stamp) creator`

const REMOTE_DISPATCH_ATTACHMENT_SQL = `INSERT INTO remote_dispatch_attachments (
   dispatch_id, home_run_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch, depth
 ) VALUES (?, ?, ?, ?, ?, ?, ?)`

/** Missing depth would turn a worker into an apparent root. */
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
    assigneeOrcaSessionId?: OrcaSessionId | null
    processIncarnation: string | null
    creatorDispatchId?: string | null
    creatorHandle?: string | null
    creatorPaneKey?: string | null
    creatorOrcaSessionId?: OrcaSessionId | null
    creatorTurnSource?: DispatchCreatorTurnSource | null
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
      params.assigneeOrcaSessionId ?? null,
      params.processIncarnation,
      params.creatorDispatchId ?? null,
      params.creatorHandle ?? null,
      params.creatorPaneKey ?? null,
      params.creatorOrcaSessionId ?? null,
      params.creatorTurnSource ?? null,
      params.priorFailures,
      params.depth,
      ...creatorStampArgs(params),
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
    retryOfDispatchId?: string | null
    creatorDispatchId?: string | null
    creatorHandle?: string | null
    creatorPaneKey?: string | null
    creatorOrcaSessionId?: OrcaSessionId | null
    creatorTurnSource?: DispatchCreatorTurnSource | null
    priorFailures: number
    followUpOfDispatchId?: string | null
    originRef?: string | null
    forMessageId?: string | null
    chatLineage?: boolean
  }
): void {
  assertStampedDepth(params.depth)
  db.prepare(STARTING_DISPATCH_CONTEXT_SQL).run(
    params.id,
    params.runId,
    params.taskId,
    params.contractVersion,
    params.launchTokenHash,
    params.retryOfDispatchId ?? null,
    params.creatorDispatchId ?? null,
    params.creatorHandle ?? null,
    params.creatorPaneKey ?? null,
    params.creatorOrcaSessionId ?? null,
    params.creatorTurnSource ?? null,
    params.depth,
    params.priorFailures,
    params.followUpOfDispatchId ?? null,
    params.originRef ?? null,
    params.forMessageId ?? null,
    params.chatLineage ? 1 : null,
    params.retryOfDispatchId ?? params.followUpOfDispatchId ?? null,
    ...creatorStampArgs(params)
  )
}

/** The worker host's record of a live worker driven by a remote Run home. */
export function insertRemoteDispatchAttachmentRow(
  db: Database.Database,
  params: {
    dispatchId: string
    runId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    /** Home-computed depth; old clients default to 1. */
    depth: number
  }
): void {
  assertStampedDepth(params.depth)
  db.prepare(REMOTE_DISPATCH_ATTACHMENT_SQL).run(
    params.dispatchId,
    params.runId,
    params.taskId,
    params.homePeerFingerprint,
    params.protocolVersion,
    params.runtimeEpoch,
    params.depth
  )
}
