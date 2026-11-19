// The bounded read behind a connector conversation's working state: only its workers that may still
// run, read off the runtime's thread, then projected with the runtime's liveness evidence.
import type { FleetDurableWorker } from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import type { SessionPartyReader } from '../../../../orchestration/addressing/session-party-reader'
import { structuredWorkerProcessIncarnation } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import type {
  ChatPartyRows,
  ConnectorWorkerCandidate
} from '../../../../orchestration/db/connector-workers/connector-worker-candidates'
import { orchestrationReader } from '../../../../orchestration/db/reader-worker/orchestration-reader-client'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { projectWorkerAttentionInput } from '../../../../orchestration/db/worker-terminal/worker-terminal-attention-query'
import { chatAssigneeSessionId } from '../../../../orchestration/workers/lifecycle/chat-assignee'
import { resolveStructuredWorkerIdentity } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'
import {
  hasPendingQuestion,
  projectDispatchFleet,
  readDispatchFleetEvidence,
  sessionWorkerActivity,
  sessionWorkerState,
  withStructuredLiveness,
  type SessionWorkersRuntime
} from './session-workers-method'

/** What a connector conversation's activity needs of each worker that may still run. */
export type SessionWorkerActivityFacts = Pick<
  OrchestrationSessionWorker,
  'state' | 'activity' | 'pendingQuestion'
>

/**
 * The connector-started workers of each of these chats that may still run, by chat: their database
 * reads all run on the orchestration reader thread in one pass, and only those workers are projected
 * here, with the runtime's liveness evidence.
 */
export async function readConnectorWorkerActivity(
  runtime: SessionWorkersRuntime,
  sessionIds: readonly string[]
): Promise<Map<string, SessionWorkerActivityFacts[]>> {
  const bySession = new Map<string, SessionWorkerActivityFacts[]>(
    sessionIds.map((sessionId) => [sessionId, []])
  )
  const db = runtime.getOrchestrationDb()
  const { candidates, federated, chatParties } = await orchestrationReader().read(
    db,
    'connectorWorkerCandidates',
    {
      sessionIds,
      now: Date.now()
    }
  )
  if (candidates.length === 0) {
    return bySession
  }
  const now = Date.now()
  const evidence = readDispatchFleetEvidence(runtime)
  const parties = prefetchedParties(db, chatParties)
  // Each chat is projected on its own, as before: a status's owner is judged among one chat's workers.
  for (const [sessionId, group] of groupBySession(candidates)) {
    const ids = new Set(group.map((candidate) => candidate.row.dispatchId))
    const { fleet, chatStatusRows } = await projectDispatchFleet(
      runtime,
      group.map((candidate) => candidate.row),
      new Map(
        group.map((candidate) => [
          candidate.row.dispatchId,
          projectWorkerAttentionInput(candidate.attention, now)
        ])
      ),
      now,
      { federatedRows: federated.filter((row) => ids.has(row.dispatch_id)), evidence, parties }
    )
    const facts = bySession.get(sessionId)
    for (const projected of fleet.workers) {
      const durable = fleet.durable.get(projected.dispatchId)
      if (!durable || !facts) {
        continue
      }
      const worker = await withStructuredLiveness(runtime, db, projected, durable)
      const state = sessionWorkerState(worker, durable)
      facts.push({
        state,
        // Only a live worker's activity is read, and only its chat's row needs the structured identity.
        activity:
          state === 'working'
            ? sessionWorkerActivity(
                worker,
                worker.liveness.verdict === 'live' && worker.stage.activity === 'unknown'
                  ? workerChatSessionId(db, worker.dispatchId, durable)
                  : null,
                chatStatusRows
              )
            : 'unknown',
        pendingQuestion: hasPendingQuestion(worker)
      })
    }
  }
  return bySession
}

function workerChatSessionId(
  db: OrchestrationDb,
  dispatchId: string,
  durable: FleetDurableWorker
): string | null {
  // The listed row already carries the handle the Dispatch lookup would find; its identity is in memory.
  const handle = durable.agentTerminalHandle
  if (!handle) {
    return resolveStructuredWorkerForDispatch(db, dispatchId)?.sessionId ?? null
  }
  return resolveStructuredWorkerIdentity(handle, db)?.sessionId ?? chatAssigneeSessionId(handle)
}

function groupBySession(
  candidates: readonly ConnectorWorkerCandidate[]
): Map<string, ConnectorWorkerCandidate[]> {
  const groups = new Map<string, ConnectorWorkerCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.sessionId) ?? []
    group.push(candidate)
    groups.set(candidate.sessionId, group)
  }
  return groups
}

/** The chats' party rows as the reader read them; a session it did not read asks the database. */
function prefetchedParties(
  db: OrchestrationDb,
  rows: readonly ChatPartyRows[]
): SessionPartyReader {
  const bySession = new Map(rows.map((row) => [row.sessionId, row]))
  const byProcess = new Map(
    rows.map((row) => [structuredWorkerProcessIncarnation(row.sessionId), row])
  )
  return {
    getWorkerTerminalResourceByProcessIncarnation: (process) => {
      const read = byProcess.get(process)
      return read
        ? (read.resource ?? undefined)
        : db.getWorkerTerminalResourceByProcessIncarnation(process)
    },
    hasRecordedStructuredWorkerSession: (session, process) => {
      const read = bySession.get(session)
      return read && byProcess.get(process) === read
        ? read.recordedWorker
        : db.hasRecordedStructuredWorkerSession(session, process)
    }
  }
}
