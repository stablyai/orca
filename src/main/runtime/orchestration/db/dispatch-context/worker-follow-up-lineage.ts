import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../../shared/agent-session-resume'
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
  const addressed = db.getDispatchContextById(dispatchId)
  if (!addressed) {
    return undefined
  }
  let latest = addressed
  const resourceOf = (id: string) =>
    db.getWorkerTerminalResourceByOwner(id) ?? db.getWorkerTerminalResourceFormerlyOwnedBy(id)
  let resource = resourceOf(latest.id)
  const seen = new Set([latest.id])
  for (;;) {
    const transferred = resource && resource.owner_dispatch_id !== latest.id ? resource : undefined
    const next =
      getFollowUpDispatch(db, latest.id) ??
      (transferred ? db.getDispatchContextById(transferred.owner_dispatch_id) : undefined)
    if (!next || seen.has(next.id)) {
      return { latest, resource }
    }
    seen.add(next.id)
    latest = next
    // A follow-up that never got a worker leaves the one before it as the worker.
    resource = resourceOf(next.id) ?? resource
  }
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
  const stored = readWorkerResumeSession(db.getWorkerTerminalResource(resourceId))
  if (
    stored?.captureHostId === getConnectionExecutionHostId(connectionId) &&
    agentProviderSessionsEqual(session.agent, stored.providerSession, session.providerSession)
  ) {
    return
  }
  db.db.prepare('UPDATE worker_terminal_resources SET resume_session = ? WHERE id = ?').run(
    JSON.stringify({
      agent: session.agent,
      providerSession: session.providerSession,
      connectionId
    }),
    resourceId
  )
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
