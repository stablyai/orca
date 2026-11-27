// The durable half of "are a connector conversation's workers still running": every read it needs, for many
// chats in one pass, with no runtime state, so the orchestration reader thread can run it.
import { ORCHESTRATION_SESSION_WORKERS_LIMIT } from '../../../../../shared/orchestration-session-workers'
import { resolveFleetWorkerOutcome } from '../../../../../shared/orchestration/fleet/orchestration-fleet-outcome-resolution'
import type { OrchestrationDbConnection } from '../orchestration-db'
import {
  projectWorkerAttentionInput,
  readWorkerAttentionInputs,
  type WorkerAttentionInput
} from '../worker-terminal/worker-terminal-attention-query'
import { listWorkerTerminalResources } from '../worker-terminal/worker-terminal-listing'
import { listFederatedDispatchesByIds } from '../../legacy-remote-home/federated-dispatch-store'
import type { FederatedDispatchRow } from '../orchestration-records'
import { readSessionPartyRows, type SessionPartyRows } from '../worker-terminal/session-party-rows'
import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'

export type ConnectorWorkerRow = ReturnType<typeof listWorkerTerminalResources>[number]

const LISTING_CHUNK = 500

/** The workers that may still run, and the paired-host rows of those started on one. */
export type ConnectorWorkerCandidates = {
  candidates: ConnectorWorkerCandidate[]
  federated: FederatedDispatchRow[]
  /** For each chat a candidate is assigned to, the two rows that name its party. */
  chatParties: SessionPartyRows[]
}

/** A worker that may still run, with what its live projection needs from the database. */
export type ConnectorWorkerCandidate = {
  sessionId: string
  row: ConnectorWorkerRow
  attention: WorkerAttentionInput
}

// Each chat's newest Dispatches through its own index, as readSessionWorkers reads them; connector ones only.
const CONNECTOR_DISPATCHES_SQL = `
  SELECT s.value AS session_id, d.id AS dispatch_id
    FROM json_each(?1) s
    JOIN dispatch_contexts d ON d.rowid IN (
      SELECT rowid FROM dispatch_contexts
       WHERE creator_orca_session_id = s.value
       ORDER BY rowid DESC LIMIT ?2
    )
   WHERE d.creator_turn_source = 'connector'`

/**
 * These chats' connector-started workers that may still run. A worker settled by its stop or its
 * outcome reads as finished whatever its host says, so it is left out here; liveness, which needs
 * the runtime, decides the rest.
 */
export function readConnectorWorkerCandidates(
  connection: OrchestrationDbConnection,
  sessionIds: readonly string[],
  now: number
): ConnectorWorkerCandidates {
  const none = { candidates: [], federated: [], chatParties: [] }
  if (sessionIds.length === 0) {
    return none
  }
  const sessionByDispatch = new Map<string, string>()
  for (const row of connection.db
    .prepare(CONNECTOR_DISPATCHES_SQL)
    .all(JSON.stringify([...new Set(sessionIds)]), ORCHESTRATION_SESSION_WORKERS_LIMIT)) {
    if (typeof row.session_id === 'string' && typeof row.dispatch_id === 'string') {
      sessionByDispatch.set(row.dispatch_id, row.session_id)
    }
  }
  if (sessionByDispatch.size === 0) {
    return none
  }
  const ids = [...sessionByDispatch.keys()]
  const rows: ConnectorWorkerRow[] = []
  // The listing binds one variable per id; a first watch of every recent chat can name thousands.
  for (let offset = 0; offset < ids.length; offset += LISTING_CHUNK) {
    rows.push(
      ...listWorkerTerminalResources.call(connection, {
        dispatchIds: ids.slice(offset, offset + LISTING_CHUNK)
      })
    )
  }
  const attention = readWorkerAttentionInputs(
    connection,
    rows.map((row) => row.dispatchId)
  )
  const candidates = rows.flatMap((row) => {
    const input = attention.get(row.dispatchId)
    const sessionId = sessionByDispatch.get(row.dispatchId)
    if (!input || !sessionId || isSettled(row, input, now)) {
      return []
    }
    return [{ sessionId, row, attention: input }]
  })
  return {
    candidates,
    federated: listFederatedDispatchesByIds.call(
      connection,
      candidates.map((candidate) => candidate.row.dispatchId)
    ),
    chatParties: readChatParties(connection, candidates)
  }
}

// What resolveOrcaSessionParty reads for a chat assignee; a chat is no worker, so both usually miss.
function readChatParties(
  connection: OrchestrationDbConnection,
  candidates: readonly ConnectorWorkerCandidate[]
): SessionPartyRows[] {
  return readSessionPartyRows.call(
    connection,
    candidates.flatMap(({ row }) => {
      const chat = row.agentTerminalHandle ? parseOrcaSessionAddress(row.agentTerminalHandle) : null
      return chat ? [chat] : []
    })
  )
}

// The settled half of sessionWorkerState, which no liveness verdict overrides.
function isSettled(row: ConnectorWorkerRow, input: WorkerAttentionInput, now: number): boolean {
  if (row.workerState === 'stopped' || row.workerState === 'abandoned') {
    return true
  }
  const outcome = resolveFleetWorkerOutcome({
    attemptOutcome: projectWorkerAttentionInput(input, now).outcome,
    workerState: row.workerState,
    dispatchStatus: row.dispatchStatus
  })
  return outcome === 'succeeded' || outcome === 'failed'
}
