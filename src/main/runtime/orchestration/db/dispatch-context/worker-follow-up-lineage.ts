import { resolveWorkerLineageFacts, FOLLOW_UP_MESSAGE_TYPES } from './worker-follow-up-plan'
export { FOLLOW_UP_MESSAGE_TYPES } from './worker-follow-up-plan'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { ExactWorkerProviderSession } from '../../../../../shared/orchestration-worker-output'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { isLocalHookConnectionId } from '../../../../../shared/wsl-hook-relay-contract'
import type { DispatchContextRow } from '../../types'
import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'

/** The conversation a closed terminal worker reopens in, as the resume path takes it. */
export type WorkerResumeSession = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  captureHostId: ExecutionHostId
}

export function getFollowUpDispatch(
  db: OrchestrationDb,
  dispatchId: string
): DispatchContextRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return db.db
    .prepare('SELECT * FROM dispatch_contexts WHERE follow_up_of_dispatch_id = ?')
    .get(dispatchId) as DispatchContextRow | undefined
}

/** A worker's newest Dispatch and resource, from any Dispatch it ran; follow-ups and `worker-start --terminal` both continue it. */
export function resolveWorkerLineage(
  db: OrchestrationDb,
  dispatchId: string
): { latest: DispatchContextRow; resource: WorkerTerminalResourceRow | undefined } | undefined {
  return resolveWorkerLineageFacts(
    {
      dispatch: (id) => db.getDispatchContextById(id),
      ownedResource: (id) => db.getWorkerTerminalResourceByOwner(id),
      formerResource: (id) => db.getWorkerTerminalResourceFormerlyOwnedBy(id),
      followUp: (id) => getFollowUpDispatch(db, id)
    },
    dispatchId
  )
}

export function readWorkerResumeSession(
  resource: Pick<WorkerTerminalResourceRow, 'resume_session'> | undefined
): WorkerResumeSession | null {
  if (!resource?.resume_session) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(resource.resume_session)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const agent = 'agent' in parsed ? parsed.agent : undefined
    const connectionId = 'connectionId' in parsed ? parsed.connectionId : undefined
    const providerSession = normalizeAgentProviderSession(
      'providerSession' in parsed ? parsed.providerSession : undefined
    )
    return isTuiAgent(agent) &&
      providerSession &&
      (connectionId === null || typeof connectionId === 'string')
      ? { agent, providerSession, captureHostId: getConnectionExecutionHostId(connectionId) }
      : null
  } catch {
    return null
  }
}

/** Keep the agent's conversation on its worker's row while hook rows still name it; they vanish with the pane. */
export function recordWorkerResumeSession(
  db: OrchestrationDb,
  resourceId: string,
  session: ExactWorkerProviderSession | null
): void {
  if (!session || !isTuiAgent(session.agent)) {
    return
  }
  // WSL relay tags are local transport; only SSH connection IDs identify remote hosts.
  const connectionId = isLocalHookConnectionId(session.connectionId)
    ? null
    : (session.connectionId ?? null)
  const value = JSON.stringify({
    agent: session.agent,
    providerSession: session.providerSession,
    connectionId
  })
  // A repeat of the stored conversation writes nothing.
  db.db
    .prepare(
      'UPDATE worker_terminal_resources SET resume_session = ? WHERE id = ? AND resume_session IS NOT ?'
    )
    .run(value, resourceId, value)
}

/** A reopened worker keeps its conversation until its own pane reports one. */
export function carryWorkerResumeSession(
  db: OrchestrationDb,
  toDispatchId: string,
  from: Pick<WorkerTerminalResourceRow, 'resume_session'>
): void {
  db.db
    .prepare(
      `UPDATE worker_terminal_resources SET resume_session = COALESCE(resume_session, ?)
        WHERE owner_dispatch_id = ?`
    )
    .run(from.resume_session, toDispatchId)
}

/** Mail a coordinator sends a working worker, and so what continues one once it has reported. */

const UNREAD_FOLLOW_UP_MAIL_SQL = `SELECT 1 FROM messages
  WHERE to_handle = 'dispatch:' || dispatch_contexts.id AND read = 0
    AND delivery_contract = 'current_delivery'
    AND type IN (${FOLLOW_UP_MESSAGE_TYPES.map((type) => `'${type}'`).join(', ')})`

/** In the report's own settlement, so a restart cannot lose mail the worker never read. */
export function markUnreadFollowUpMail(db: OrchestrationDb, dispatchId: string): void {
  db.db
    .prepare(
      `UPDATE dispatch_contexts SET follow_up_mail_at = datetime('now')
        WHERE id = ? AND EXISTS (${UNREAD_FOLLOW_UP_MAIL_SQL})`
    )
    .run(dispatchId)
}

/** In the follow-up's claim, so its first `check` finds the mail; its start prompt is that mail's wake. A pointer whose Enter is in flight keeps its stamps to settle. */
export function takeFollowUpMail(
  db: OrchestrationDb,
  fromDispatchId: string,
  toDispatchId: string
): void {
  db.db
    .prepare(
      `UPDATE messages
          SET to_handle = ?,
              delivered_at = CASE WHEN pointer_enter_pending = 0 THEN datetime('now') ELSE delivered_at END,
              pointer_pty_id = CASE WHEN pointer_enter_pending = 0 THEN NULL ELSE pointer_pty_id END,
              pointer_process_incarnation =
                CASE WHEN pointer_enter_pending = 0 THEN NULL ELSE pointer_process_incarnation END
        WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'`
    )
    .run(`dispatch:${toDispatchId}`, `dispatch:${fromDispatchId}`)
  // Until the follow-up is ready, a restart must find this mail on it.
  markUnreadFollowUpMail(db, toDispatchId)
}

/** Mail a follow-up held from before it started is what its Task pointed at; only newer mail starts another. */
export function hasNewUnreadFollowUpMail(db: OrchestrationDb, dispatchId: string): boolean {
  return Boolean(
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts WHERE id = ? AND EXISTS (${UNREAD_FOLLOW_UP_MAIL_SQL}
           AND (dispatch_contexts.follow_up_of_dispatch_id IS NULL
             OR messages.created_at >= dispatch_contexts.created_at))`
      )
      .get(dispatchId)
  )
}

export function clearFollowUpMail(db: OrchestrationDb, dispatchId: string): void {
  db.db
    .prepare('UPDATE dispatch_contexts SET follow_up_mail_at = NULL WHERE id = ?')
    .run(dispatchId)
}

export function listDispatchesWithFollowUpMail(db: OrchestrationDb): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the id column.
  const rows = db.db
    .prepare('SELECT id FROM dispatch_contexts WHERE follow_up_mail_at IS NOT NULL')
    .all() as { id: string }[]
  return rows.map((row) => row.id)
}

/** The worker resource Orca still holds for a pane, whose conversation a provider-session change moves. */
export function findHeldWorkerResourceForPane(
  db: OrchestrationDb,
  paneKey: string
): WorkerTerminalResourceRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return db.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE pane_key = ? AND ownership_state != 'released' ORDER BY updated_at DESC LIMIT 1`
    )
    .get(paneKey) as WorkerTerminalResourceRow | undefined
}
