/**
 * Where a mailbox owned by a structured session is delivered, for sessions that are not structured
 * workers: a chat that coordinates a Run (`run:<id>` with no coordinator handle) and a session
 * addressed directly at `session:<id>`.
 *
 * The session is resolved here, never a pane: its native view takes the pointer as a session turn
 * (the structured lane), its terminal view as bytes typed into the PTY that owns it (the PTY lane).
 * Exactly one view answers for a session at a time, so the two lanes never both claim a mailbox.
 */

import {
  ORCA_SESSION_ADDRESS_PREFIX,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import { agentSessionPtyWriteGate } from '../agent-session-pty-write-gate'
import type { OrchestrationDb } from './db'
import { currentRunCoordinatorOrcaSessionId } from './db/runs/run-coordinator-orca-session'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import {
  readAgentSessionRecordStore,
  sessionOrchestrationIdentity,
  structuredSessionDeliveryView,
  structuredSessionMailReach,
  type AgentSessionRecordReader
} from './structured-session-mail-address'
import type { RunRow } from './types'

/** The live PTY the write gate binds to a session: its terminal view, when a TUI owns it. */
export function findConnectedPtyBoundToSession<T extends { ptyId: string; connected: boolean }>(
  ptys: Iterable<T>,
  sessionId: string
): T | undefined {
  for (const pty of ptys) {
    if (pty.connected && agentSessionPtyWriteGate.boundSessionId(pty.ptyId) === sessionId) {
      return pty
    }
  }
  return undefined
}

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
 * The session that takes a pointer for `sessionId`'s conversation now (its live session, whichever
 * session of the lineage was named) and through which view; null when mail cannot reach it here.
 */
export function structuredSessionMailDestination(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): { sessionId: string; view: 'session-turn' | 'terminal-view' } | null {
  const record = store?.getRecord(sessionId)
  const reach = store && record ? structuredSessionMailReach(store, record, db) : null
  return reach?.kind === 'reachable'
    ? { sessionId: reach.session.sessionId, view: structuredSessionDeliveryView(reach.session) }
    : null
}

/** The structured-lane target for a session whose native view takes the pointer. */
export function structuredSessionMailTarget(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredPointerTarget | null {
  const destination = structuredSessionMailDestination(sessionId, db)
  return destination?.view === 'session-turn'
    ? { sessionId: destination.sessionId, dispatchId: null }
    : null
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
 * Every mailbox a session reads for itself: the Runs it coordinates and its own direct mail.
 * Re-derived from the database on each idle edge rather than remembered, so mail that arrived
 * while the session could not take it (closed, evicted, in the other view) is found again.
 */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  if (!isOrcaSessionId(sessionId)) {
    return []
  }
  const identity = sessionOrchestrationIdentity(sessionId, db)
  const mailboxes = db.runsBoundToCoordinator(identity).map((run) => `run:${run.id}`)
  if (db.getUnreadDirectMessageTypes(identity.address).length > 0) {
    mailboxes.push(identity.address)
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
