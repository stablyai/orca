// The bounded read behind a connector conversation's working state: only its workers that may still
// run, read off the runtime's thread, then projected with the runtime's liveness evidence.
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { prefetchedSessionParties } from '../../../../orchestration/addressing/session-party-reader'
import type { ConnectorWorkerCandidate } from '../../../../orchestration/db/connector-workers/connector-worker-candidates'
import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  type FleetDurableWorker
} from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { fleetWorkerIdentity } from '../../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
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
  const parties = prefetchedSessionParties(db, chatParties)
  const sessionOf = new Map(
    candidates.map((candidate) => [candidate.row.dispatchId, candidate.sessionId])
  )
  // Projected in as few passes as keep each conversation's status owners its own (see packConversations),
  // one after another: a later pass then finds a paired host that missed its deadline marked overdue
  // instead of queueing behind its unanswered read.
  const projections: Awaited<ReturnType<typeof projectDispatchFleet>>[] = []
  for (const group of packConversations(candidates)) {
    const ids = new Set(group.map((candidate) => candidate.row.dispatchId))
    projections.push(
      await projectDispatchFleet(
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
    )
  }
  for (const { fleet, chatStatusRows } of projections) {
    for (const projected of fleet.workers) {
      const durable = fleet.durable.get(projected.dispatchId)
      const facts = bySession.get(sessionOf.get(projected.dispatchId) ?? '')
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

/**
 * Conversations packed into projections no two of which share a pane or terminal handle across
 * conversations. A pane-bound status counts only when one projected worker owns its pane and handle,
 * so a projection holding one conversation's workers judges owners exactly as reading it alone did;
 * conversations that share none (the usual case) all fit one projection.
 */
function packConversations(
  candidates: readonly ConnectorWorkerCandidate[]
): ConnectorWorkerCandidate[][] {
  const bySession = new Map<string, ConnectorWorkerCandidate[]>()
  for (const candidate of candidates) {
    const group = bySession.get(candidate.sessionId) ?? []
    group.push(candidate)
    bySession.set(candidate.sessionId, group)
  }
  const packs: { owners: Map<string, string>; candidates: ConnectorWorkerCandidate[] }[] = []
  for (const [sessionId, group] of bySession) {
    const keys = group.flatMap(({ row }) => identityKeys(row))
    // One fleet page per pack, so no conversation's workers straddle a page's owner index.
    let pack = packs.find(
      (candidate) =>
        candidate.candidates.length + group.length <= ORCHESTRATION_FLEET_PAGE_MAX &&
        keys.every((key) => (candidate.owners.get(key) ?? sessionId) === sessionId)
    )
    if (!pack) {
      pack = { owners: new Map(), candidates: [] }
      packs.push(pack)
    }
    for (const key of keys) {
      pack.owners.set(key, sessionId)
    }
    pack.candidates.push(...group)
  }
  return packs.map((pack) => pack.candidates)
}

function identityKeys(row: ConnectorWorkerCandidate['row']): string[] {
  const identity = fleetWorkerIdentity(row)
  if (identity.kind === 'unidentifiable') {
    return []
  }
  const handle = `handle:${identity.terminalHandle}`
  return identity.kind === 'pane_and_terminal' ? [handle, `pane:${identity.paneKey}`] : [handle]
}
