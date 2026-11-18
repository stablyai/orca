// The bounded read behind a connector conversation's working state: only its workers that may still
// run, read off the runtime's thread, then projected with the runtime's liveness evidence.
import type { FleetDurableWorker } from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { orchestrationReader } from '../../../../orchestration/db/reader-worker/orchestration-reader-client'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { projectWorkerAttentionInput } from '../../../../orchestration/db/worker-terminal/worker-terminal-attention-query'
import { chatAssigneeSessionId } from '../../../../orchestration/workers/lifecycle/chat-assignee'
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'
import {
  hasPendingQuestion,
  projectDispatchFleet,
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
  const { candidates, federated } = await orchestrationReader().read(
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
  const { fleet, chatStatusRows } = await projectDispatchFleet(
    runtime,
    candidates.map((candidate) => candidate.row),
    new Map(
      candidates.map((candidate) => [
        candidate.row.dispatchId,
        projectWorkerAttentionInput(candidate.attention, now)
      ])
    ),
    now,
    federated
  )
  const sessionOf = new Map(
    candidates.map((candidate) => [candidate.row.dispatchId, candidate.sessionId])
  )
  for (const projected of fleet.workers) {
    const durable = fleet.durable.get(projected.dispatchId)
    const sessionId = sessionOf.get(projected.dispatchId)
    if (!durable || sessionId === undefined) {
      continue
    }
    const worker = await withStructuredLiveness(runtime, db, projected, durable)
    const state = sessionWorkerState(worker, durable)
    bySession.get(sessionId)?.push({
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
  return bySession
}

function workerChatSessionId(
  db: OrchestrationDb,
  dispatchId: string,
  durable: FleetDurableWorker
): string | null {
  return (
    resolveStructuredWorkerForDispatch(db, dispatchId)?.sessionId ??
    chatAssigneeSessionId(durable.agentTerminalHandle)
  )
}
