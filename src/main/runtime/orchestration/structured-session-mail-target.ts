/**
 * Where a mailbox owned by a structured session is delivered, for sessions that are not structured
 * workers: a chat that coordinates a Run (`run:<id>` with no coordinator handle) and a session
 * addressed directly at `session:<id>`.
 *
 * The session is resolved here, never a pane: its native view takes the pointer as a session turn
 * (the structured lane), its terminal view as bytes typed into the PTY that owns it (the PTY lane).
 * Exactly one view answers for a session at a time, so the two lanes never both claim a mailbox.
 */

import { parseOrchestrationActor } from '../../../shared/orchestration-actor'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionPtyWriteGate } from '../agent-session-pty-write-gate'
import type { OrchestrationDb } from './db'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import {
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

export function readAgentSessionRecordStore(): AgentSessionRecordReader | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}

/**
 * The session a Run's coordinator binding names when that binding has no handle. A structured
 * worker coordinates by its own handle and resolves through it; an actor beside any handle is
 * stale (see `runBoundToCoordinator`), so only a handle-less binding names a session here.
 */
export function handleLessCoordinatorSessionId(
  run: Pick<RunRow, 'coordinator_handle' | 'coordinator_actor'>
): string | null {
  if (run.coordinator_handle !== null) {
    return null
  }
  return parseOrchestrationActor(run.coordinator_actor)?.id ?? null
}

/** Which view of the session takes a pointer now, or null when mail cannot reach it here. */
export function structuredSessionMailView(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): 'session-turn' | 'terminal-view' | null {
  const record = store?.getRecord(sessionId)
  if (!store || !record || structuredSessionMailReach(store, record, db).kind !== 'reachable') {
    return null
  }
  return structuredSessionDeliveryView(record)
}

/** The structured-lane target for a session whose native view takes the pointer. */
export function structuredSessionMailTarget(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredPointerTarget | null {
  return structuredSessionMailView(sessionId, db) === 'session-turn'
    ? { sessionId, dispatchId: null }
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
  if (!mailboxHandle.startsWith('session:')) {
    return undefined
  }
  const actor = parseOrchestrationActor(mailboxHandle)
  return actor ? structuredSessionMailTarget(actor.id, db) : null
}

/**
 * Every mailbox a session reads for itself: the Runs it coordinates and its own direct mail.
 * Re-derived from the database on each idle edge rather than remembered, so mail that arrived
 * while the session could not take it (closed, evicted, in the other view) is found again.
 */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  const identity = sessionOrchestrationIdentity(sessionId, db)
  const mailboxes = db.runsBoundToCoordinator(identity).map((run) => `run:${run.id}`)
  if (db.getUnreadDirectMessageTypes(identity.address).length > 0) {
    mailboxes.push(identity.address)
  }
  return mailboxes
}
