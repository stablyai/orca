/** Resolve structured-owned mail to a session turn, covering Run, session, Dispatch and worker-handle addresses. */

import {
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../../shared/orca-session-address'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/orca-session-address-prefix'

import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { currentRunCoordinatorOrcaSessionId } from '../../db/runs/run-coordinator-orca-session'
import type { StructuredPointerTarget } from '../structured-pointer/structured-mailbox-pointer-delivery'
import {
  addressableSessionParty,
  structuredSessionMailReach
} from './structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../../addressing/session-lineage/structured-session-lineage'
import type { RunRow } from '../../db/orchestration-records'
import { chatAssigneeSessionId } from '../../workers/lifecycle/chat-assignee'
import { structuredWorkerCustody } from '../../terminal-authority/structured-sessions/structured-worker-authority'

/** A handle-less coordinator uses its generation-current session id; structured workers resolve by handle. */
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

/** Who holds a mailbox: the chat session its mail reaches; someone else (a terminal, a released worker,
 *  another host, an ended conversation); or a fact needed to decide that cannot be read now. */
export type StructuredMailboxCustody = StructuredPointerTarget | 'elsewhere' | 'unverifiable'

/** Any lineage session's custody: its live reachable session, or why mail cannot reach it. */
export function structuredSessionMailCustody(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): StructuredMailboxCustody {
  if (!store) {
    return 'unverifiable'
  }
  const record = store.getRecord(sessionId)
  if (!record) {
    return store.isSessionUnreadable?.(sessionId) ? 'unverifiable' : 'elsewhere'
  }
  const reach = structuredSessionMailReach(store, record, db)
  if (reach.kind === 'reachable') {
    return { sessionId: reach.session.sessionId, dispatchId: null }
  }
  return reach.kind === 'unverifiable' ? 'unverifiable' : 'elsewhere'
}

/** Resolve any lineage session to its live reachable target; null means unreachable here. */
export function structuredSessionMailTarget(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): StructuredPointerTarget | null {
  const custody = structuredSessionMailCustody(sessionId, db, store)
  return typeof custody === 'object' ? custody : null
}

function withDispatch(custody: StructuredMailboxCustody, dispatchId: string | null) {
  return typeof custody === 'object' ? { ...custody, dispatchId } : custody
}

function workerMailCustody(
  handle: string,
  db: OrchestrationDb | null | undefined,
  /** Undefined: direct mail, routed through the worker's active Dispatch if it has one. */
  dispatchId?: string | null
): StructuredMailboxCustody {
  const worker = structuredWorkerCustody(handle, db)
  if (typeof worker !== 'object') {
    return worker
  }
  // Direct worker mail goes through its active Dispatch, or a session-scoped ledger between Dispatches.
  const active =
    dispatchId === undefined
      ? (db?.findActiveDispatchForAssignee?.(handle, worker.identity.paneKey)?.id ?? null)
      : dispatchId
  return { sessionId: worker.running.sessionId, dispatchId: active }
}

/** Every structured-owned mailbox: Run, session address, Dispatch and direct worker handle. Only a
 *  readable fact naming someone else is `elsewhere`; a fact that cannot be read is `unverifiable`. */
export function structuredMailboxCustody(
  mailboxHandle: string,
  db: OrchestrationDb | null | undefined
): StructuredMailboxCustody {
  if (mailboxHandle.startsWith('run:')) {
    const run = db?.getRun?.(mailboxHandle.slice('run:'.length))
    const sessionId = run ? handleLessCoordinatorSessionId(run) : null
    if (sessionId) {
      return structuredSessionMailCustody(sessionId, db)
    }
    // Coordinators need Run nudges after turns end; no blocking check waiter or Dispatch is required.
    return run?.coordinator_handle
      ? workerMailCustody(run.coordinator_handle, db, null)
      : 'elsewhere'
  }
  if (mailboxHandle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    const sessionId = parseOrcaSessionAddress(mailboxHandle)
    return sessionId ? structuredSessionMailCustody(sessionId, db) : 'elsewhere'
  }
  if (!mailboxHandle.startsWith('dispatch:')) {
    return workerMailCustody(mailboxHandle, db)
  }
  const dispatch = db?.getDispatchContextById?.(mailboxHandle.slice('dispatch:'.length))
  // A Dispatch's mail follows its Task: none reaches the chat before it took the Task, or after it ended.
  if (!dispatch?.assignee_handle || dispatch.status !== 'dispatched') {
    return 'elsewhere'
  }
  const chat = chatAssigneeSessionId(dispatch.assignee_handle)
  return chat
    ? withDispatch(structuredSessionMailCustody(chat, db), dispatch.id)
    : workerMailCustody(dispatch.assignee_handle, db, dispatch.id)
}

/** Re-derive Run, direct and active-Dispatch mail on each idle edge, including root mail for /clear successors. */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  const party = isOrcaSessionId(sessionId) ? addressableSessionParty(sessionId, db) : null
  if (!party) {
    return []
  }
  const mailboxes = db.runsBoundToCoordinator(party).map((run) => `run:${run.id}`)
  if (db.getUnreadDirectMessageTypes(party.address).length > 0) {
    mailboxes.push(party.address)
  }
  // Re-derive Dispatch mail through current party identity; a cleared or restarted session has no future idle edge.
  const dispatch = db.findActiveDispatchForAssignee(party.address, party.paneKey ?? undefined)
  if (dispatch) {
    mailboxes.push(`dispatch:${dispatch.id}`)
  }
  return mailboxes
}

/** Open an existing DB to redrive restart mail; no file means no mail and creates no DB. */
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
