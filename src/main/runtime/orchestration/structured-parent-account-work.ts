import { structuredWorkerAddressable } from '../structured-worker-custody'
import { isOrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { OrchestrationDb } from './db'
import { currentRunCoordinatorOrcaSessionId } from './db/runs/run-coordinator-orca-session'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import {
  addressableSessionParty,
  structuredSessionMailReach
} from './structured-session-mail-address'
import type { AgentSessionRecordReader } from './structured-session-lineage'

export type NativeResponseEvidence = { pending: Iterable<string>; disposed: ReadonlySet<string> }

/** Current canonical recipients own future reports; original creator provenance does not. */
export function structuredParentAccountWork(
  db: OrchestrationDb | null,
  record: AgentSessionRecord,
  root: string,
  response: NativeResponseEvidence,
  reader: AgentSessionRecordReader
): boolean {
  if (!db || !isOrcaSessionId(root)) {
    return false
  }
  const original = reader.getRecord(root)
  const reach = original && structuredSessionMailReach(reader, original, db, reader)
  if (!reach || reach.kind !== 'reachable' || reach.session.sessionId !== record.sessionId) {
    return false
  }
  const party = addressableSessionParty(root, db, reader)
  if (!party) {
    return false
  }
  if (
    party.terminalHandle &&
    !structuredWorkerAddressable(
      db,
      {
        sessionId: reach.session.sessionId,
        record: reach.session,
        lineage: reader.listRecords().map((item) => item.sessionId)
      },
      db.getWorkerTerminalResourceByHandle(party.terminalHandle),
      {
        getPersistedVisibleSessionTabIndex: () =>
          reader.getVisibleSessionTabIndex?.() ?? { present: false, sessionIds: [] }
      }
    )
  ) {
    return false
  }
  const mailboxes = new Map<string, { runId: string; mailbox: string }>()
  const runs = new Set<string>()
  const dispatches = new Set<string>()
  const add = (runId: string, mailbox: string) => {
    mailboxes.set(`${runId}\0${mailbox}`, { runId, mailbox })
  }
  const runCandidates = db.db
    .prepare(`SELECT id FROM runs WHERE coordinator_orca_session_id = ?
    UNION SELECT id FROM runs WHERE coordinator_handle = ?`)
    .all(root, party.terminalHandle)
  for (const run of party.paneKey ? db.runsBoundToPane(party.paneKey) : []) {
    runCandidates.push({ id: run.id })
  }
  for (const candidate of runCandidates) {
    if (typeof candidate.id !== 'string') {
      continue
    }
    const run = db.getRunRaw(candidate.id)
    if (
      run &&
      (run.coordinator_handle !== null
        ? run.coordinator_handle === party.terminalHandle
        : currentRunCoordinatorOrcaSessionId(run) === root)
    ) {
      runs.add(run.id)
      add(run.id, `run:${run.id}`)
    }
  }
  const assigned = db.db
    .prepare(`SELECT id FROM dispatch_contexts
    WHERE assignee_orca_session_id = ? AND status IN ('pending', 'dispatched')
    UNION SELECT id FROM dispatch_contexts WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')`)
    .all(root, party.address)
  for (const candidate of assigned) {
    if (typeof candidate.id !== 'string') {
      continue
    }
    const dispatch = db.getDispatchContextById(candidate.id)
    if (dispatch?.assignee_handle === party.address) {
      dispatches.add(dispatch.id)
      add(dispatch.run_id, `dispatch:${dispatch.id}`)
    }
  }
  const candidates = new Set<string>()
  const byRun = db.db.prepare(
    `SELECT id FROM dispatch_contexts WHERE run_id = ? AND status IN ('pending', 'dispatched')`
  )
  const byCreator = db.db.prepare(
    `SELECT id FROM dispatch_contexts WHERE creator_dispatch_id = ? AND status IN ('pending', 'dispatched')`
  )
  for (const rows of [
    ...Array.from(runs, (id) => byRun.all(id)),
    ...Array.from(dispatches, (id) => byCreator.all(id))
  ]) {
    for (const row of rows) {
      if (typeof row.id === 'string') {
        candidates.add(row.id)
      }
    }
  }
  for (const id of candidates) {
    const dispatch = db.getDispatchContextById(id)
    if (dispatch && mailboxes.has(`${dispatch.run_id}\0${dispatchReportMailbox(db, dispatch)}`)) {
      return true
    }
  }
  const unread = db.db.prepare(`SELECT id FROM messages WHERE run_id = ? AND to_handle = ?
    AND type = 'worker_done' AND read = 0 AND delivered_at IS NULL AND delivery_contract <> 'audit_only'`)
  const direct = db.db.prepare(`SELECT id FROM messages WHERE to_handle = ?
    AND type = 'worker_done' AND read = 0 AND delivered_at IS NULL AND delivery_contract <> 'audit_only'`)
  const exact = db.db
    .prepare(`SELECT run_id, to_handle FROM messages WHERE id = ? AND type = 'worker_done'
    AND delivery_contract <> 'audit_only'`)
  for (const { runId, mailbox } of mailboxes.values()) {
    if (
      unread
        .all(runId, mailbox)
        .some((message) => typeof message.id === 'string' && !response.disposed.has(message.id))
    ) {
      return true
    }
  }
  if (
    direct
      .all(party.address)
      .some((message) => typeof message.id === 'string' && !response.disposed.has(message.id))
  ) {
    return true
  }
  // Acknowledgement does not dispose a response already accepted by the current recipient.
  for (const id of response.pending) {
    const message = exact.get(id)
    if (
      message &&
      (message.to_handle === party.address ||
        mailboxes.has(`${String(message.run_id)}\0${String(message.to_handle)}`))
    ) {
      return true
    }
  }
  return false
}
