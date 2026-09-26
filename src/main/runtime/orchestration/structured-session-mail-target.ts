/**
 * Where a mailbox owned by a structured session is delivered: a chat that coordinates a Run
 * (`run:<id>` with no coordinator handle), a session addressed directly at `session:<id>`, a chat
 * holding a Dispatch, and the live session behind a structured worker's handle. The session is resolved here, never a pane, and
 * takes the pointer as a session turn.
 */

import {
  ORCA_SESSION_ADDRESS_PREFIX,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { currentRunCoordinatorOrcaSessionId } from './db/runs/run-coordinator-orca-session'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import {
  addressableSessionParty,
  structuredSessionMailReach
} from './structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  resolveExecutingSession,
  type AgentSessionRecordReader
} from './structured-session-lineage'
import type { RunRow } from './types'

/**
 * The session a Run's coordinator binding names when that binding has no handle. A structured
 * worker coordinates by its own handle and resolves through it, so only a handle-less binding names
 * a session here, and only by an Orca session id that still counts (see
 * `currentRunCoordinatorOrcaSessionId`).
 */
export function handleLessCoordinatorSessionId(
  run: Pick<
    RunRow,
    | 'coordinator_handle'
    | 'coordinator_orca_session_id'
    | 'coordinator_orca_session_id_generation'
    | 'consumer_generation'
  >
): OrcaSessionId | null {
  if (run.coordinator_handle !== null) {
    return null
  }
  return currentRunCoordinatorOrcaSessionId(run)
}

/**
 * The structured-lane target for `sessionId`'s conversation: its live session, whichever session of
 * the lineage was named; null when mail cannot reach it here.
 */
export function structuredSessionMailTarget(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): StructuredPointerTarget | null {
  const record = store?.getRecord(sessionId)
  const reach = store && record ? structuredSessionMailReach(store, record, db) : null
  return reach?.kind === 'reachable'
    ? { sessionId: reach.session.sessionId, dispatchId: null }
    : null
}

/**
 * The session a structured worker's mail reaches: the one minted for it, or that session's live
 * `/clear` successor, which carries on as the worker the way a terminal keeps its handle. Null
 * whenever it cannot be delivered here.
 */
export function structuredWorkerMailSessionId(
  mintedSessionId: string,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): string | null {
  const executing = store ? resolveExecutingSession(store, mintedSessionId) : null
  return executing?.kind === 'here' ? executing.sessionId : null
}

/**
 * The target of a `session:<id>` mailbox; `undefined` when the handle is not a session address at
 * all, so other address forms keep their own resolution.
 */
export function structuredSessionAddressTarget(
  mailboxHandle: string,
  db: OrchestrationDb | null | undefined
): StructuredPointerTarget | null | undefined {
  if (!mailboxHandle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    return undefined
  }
  const sessionId = parseOrcaSessionAddress(mailboxHandle)
  return sessionId ? structuredSessionMailTarget(sessionId, db) : null
}

/**
 * Every mailbox a session reads for itself: the Runs it coordinates, the Dispatches it holds as a
 * chat assignee (the first of which carries its owed preamble), and its own direct mail.
 * Re-derived from the database on each idle edge rather than remembered, so mail that arrived
 * while the session could not take it (closed, evicted, restarted) is found again.
 */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  const party = isOrcaSessionId(sessionId) ? addressableSessionParty(sessionId, db) : null
  if (!party) {
    return []
  }
  const mailboxes = db.runsBoundToCoordinator(party).map((run) => `run:${run.id}`)
  if (party.terminalHandle === null) {
    for (const dispatch of db.getActiveDispatchMailboxOwners(party.address)) {
      mailboxes.push(`dispatch:${dispatch.id}`)
    }
  }
  if (db.getUnreadDirectMessageTypes(party.address).length > 0) {
    mailboxes.push(party.address)
  }
  return mailboxes
}

/** The mailboxes a session's idle edge re-derives, opening an existing database if nothing has
 *  yet: after a restart this edge is what redrives mail stored before it. No database file means
 *  no mail, so `openDb` answers null and nothing is created. */
export function structuredSessionIdleEdgeMailboxes(
  sessionId: string,
  openDb: () => OrchestrationDb | null
): string[] {
  let db: OrchestrationDb | null
  try {
    db = openDb()
  } catch (error) {
    console.warn('[orchestration] skipped a structured session mail edge: no database', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
  return db ? structuredSessionOwnedMailboxes(sessionId, db) : []
}
