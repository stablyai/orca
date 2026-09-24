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
  formatOrchestrationActor,
  parseOrchestrationActor
} from '../../../shared/orchestration-actor'
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
 * `/clear` replaces a chat with a new Orca session and the conversation continues there, so what
 * the old session coordinated and was sent follows it: its Runs are rebound through the ordinary
 * bind (a coordinator takeover: generation bump, fenced deliveries, rerouted coordinator mail), and
 * its unread direct mail is re-addressed. Re-derived on the successor's status edges rather than
 * fired once at the clear, so nothing between the clear and the rebind can strand it. Returns the
 * Runs it rebound.
 */
export function adoptClearedPredecessorMail(
  sessionId: string,
  db: OrchestrationDb,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): string[] {
  const records = store?.listRecords() ?? []
  const lineage = new Set([sessionId])
  const predecessors: string[] = []
  for (let grew = true; grew;) {
    grew = false
    for (const record of records) {
      const cleared = record.conversationCommand
      if (
        cleared?.command === 'clear' &&
        cleared.phase === 'committed' &&
        cleared.replacementSessionId !== undefined &&
        lineage.has(cleared.replacementSessionId) &&
        !lineage.has(record.sessionId)
      ) {
        lineage.add(record.sessionId)
        predecessors.push(record.sessionId)
        grew = true
      }
    }
  }
  const successor = formatOrchestrationActor({ kind: 'session', id: sessionId })
  const rebound: string[] = []
  for (const predecessor of predecessors) {
    const actor = formatOrchestrationActor({ kind: 'session', id: predecessor })
    for (const run of db.runsBoundToCoordinator({ actor, terminalHandle: null, paneKey: null })) {
      if (
        db.bindRun({
          runId: run.id,
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorActor: successor
        })
      ) {
        rebound.push(run.id)
      }
    }
    db.readdressUnreadSessionMail(actor, successor)
  }
  return rebound
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

/** What a session's idle edge owes its mail: Runs adopted from a `/clear` predecessor, then every
 *  mailbox the session owns, re-derived. */
export function structuredSessionIdleEdgeMail(
  sessionId: string,
  db: OrchestrationDb | null
): { reboundRunIds: string[]; mailboxes: string[] } {
  if (!db) {
    return { reboundRunIds: [], mailboxes: [] }
  }
  const reboundRunIds = adoptClearedPredecessorMail(sessionId, db)
  return { reboundRunIds, mailboxes: structuredSessionOwnedMailboxes(sessionId, db) }
}
