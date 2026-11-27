import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { isDispatchAssignee } from '../dispatch-context/dispatch-lookup'
import type { OrchestrationDb } from '../orchestration-db'
import type { DispatchContextRow, RemoteDispatchAttachmentRow } from '../orchestration-records'
import {
  coordinatorRecipients,
  latestConsumedCoordinatorMessage,
  parseDispatchUtcMs,
  type ConsumedCoordinatorMessage
} from './dispatch-read-mail'

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const OUTBOUND_REPORT_TYPES = new Set([
  'status',
  'question',
  'escalation',
  'worker_done',
  'merge_ready',
  'handoff'
])
const SYSTEM_REPORT_ID_PREFIXES = [
  'msg_stop_',
  'msg_rest_',
  'msg_chaterr_',
  'msg_followup_',
  'msg_unlinked_'
]
const CANDIDATE_COLUMNS =
  'id, sequence, from_handle, to_handle, type, thread_id, payload, sender_pane_key, created_at'

type OutboundReportTarget =
  | { kind: 'local'; dispatch: DispatchContextRow }
  | { kind: 'remote'; attachment: Pick<RemoteDispatchAttachmentRow, 'dispatch_id' | 'task_id'> }
type OutboundReportStop = {
  mailTaken?: number
  latestCoordinatorSequence?: number
  turnStartedAt?: number
  turnStartedAfterSequence?: number
}
type CandidateMessage = {
  id: string
  sequence: number
  from: string
  to: string
  type: string
  threadId: string | null
  payload: string | null
  senderPaneKey: string | null
  createdAt: string
}

/** Whether the worker already sent an outbound reply or report to its coordinator/Run for this turn. */
export function hasOutboundCoordinatorReport(
  db: OrchestrationDb,
  target: OutboundReportTarget,
  stop: OutboundReportStop
): boolean {
  if (target.kind === 'remote') {
    return hasRemoteOutboundReport(db, target.attachment.dispatch_id, stop)
  }
  const { dispatch } = target
  const latest = latestConsumedCoordinatorMessage(db, dispatch.id, stop)
  const recipients = coordinatorRecipients(db, dispatch, latest?.from)
  const { candidates, provenanceIds } = readWorkerOutboundCandidates(
    db,
    dispatch,
    latest?.sequence ?? 0
  )
  const dispatchCreatedAt = parseDispatchUtcMs(dispatch.created_at)
  const dispatchCompletedAt = Date.parse(dispatch.completed_at ?? '')
  const assigneeSession = dispatch.assignee_orca_session_id
    ? formatOrcaSessionAddress(dispatch.assignee_orca_session_id)
    : null
  return candidates.some((candidate) => {
    if (!isWorkerReportCandidate(db, dispatch.id, candidate) || !recipients.has(candidate.to)) {
      return false
    }
    const sentAt = parseDispatchUtcMs(candidate.createdAt)
    const fromThisDispatch =
      provenanceIds.has(candidate.id) ||
      candidate.from === `dispatch:${dispatch.id}` ||
      ((latest ? candidate.sequence > latest.sequence : sentAt >= dispatchCreatedAt) &&
        (Number.isNaN(dispatchCompletedAt) || sentAt <= dispatchCompletedAt) &&
        (isDispatchAssignee(dispatch, candidate.from, candidate.senderPaneKey) ||
          assigneeSession === candidate.from))
    if (!fromThisDispatch) {
      return false
    }
    if (latest) {
      return (
        answersCoordinatorMessage(candidate, latest) ||
        (candidate.sequence > latest.sequence && sentInCurrentLocalTurn(candidate, stop))
      )
    }
    return sentAt >= dispatchCreatedAt && sentInCurrentLocalTurn(candidate, stop)
  })
}

function isWorkerReportCandidate(
  db: OrchestrationDb,
  dispatchId: string,
  candidate: CandidateMessage
): boolean {
  if (!OUTBOUND_REPORT_TYPES.has(candidate.type) || isSystemReportId(candidate.id)) {
    return false
  }
  if (
    candidate.from === `dispatch:${dispatchId}` &&
    typeof parseJsonRecord(candidate.payload)?.setupState === 'string'
  ) {
    return false
  }
  const outcome =
    candidate.threadId && candidate.payload === null
      ? db.getBotRequestOutcome(candidate.threadId)
      : null
  return outcome === null || outcome === 'answered'
}

function readWorkerOutboundCandidates(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  afterSequence: number
): { candidates: CandidateMessage[]; provenanceIds: Set<string> } {
  const byId = new Map<string, CandidateMessage>()
  const provenanceIds = new Set<string>()
  const addRows = (rows: Record<string, unknown>[], fromProvenance = false): void => {
    for (const row of rows) {
      const id = text(row.id)
      const from = text(row.from_handle)
      const to = text(row.to_handle)
      const type = text(row.type)
      const createdAt = text(row.created_at)
      if (!id || !from || !to || !type || !createdAt || typeof row.sequence !== 'number') {
        continue
      }
      if (fromProvenance) {
        provenanceIds.add(id)
      }
      byId.set(id, {
        id,
        sequence: row.sequence,
        from,
        to,
        type,
        threadId: text(row.thread_id),
        payload: text(row.payload),
        senderPaneKey: text(row.sender_pane_key),
        createdAt
      })
    }
  }
  addRows(
    db.db
      .prepare(
        `SELECT m.id, m.sequence, m.from_handle, m.to_handle, m.type, m.thread_id, m.payload, m.sender_pane_key, m.created_at
           FROM message_dispatch_provenance p JOIN messages m ON m.id = p.message_id
          WHERE p.dispatch_id = ? AND m.type <> 'heartbeat'`
      )
      .all(dispatch.id),
    true
  )
  const handles = new Set<string>([
    `dispatch:${dispatch.id}`,
    ...(dispatch.assignee_handle ? [dispatch.assignee_handle] : []),
    ...(dispatch.assignee_orca_session_id
      ? [formatOrcaSessionAddress(dispatch.assignee_orca_session_id)]
      : [])
  ])
  const byFromStmt = db.db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM messages WHERE from_handle = ? AND type <> 'heartbeat'`
  )
  for (const handle of handles) {
    addRows(byFromStmt.all(handle))
  }
  if (dispatch.assignee_pane_key) {
    addRows(
      db.db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM messages WHERE run_id = ? AND sequence > ? AND type <> 'heartbeat'`
        )
        .all(dispatch.run_id, afterSequence)
    )
  }
  return { candidates: [...byId.values()], provenanceIds }
}

function answersCoordinatorMessage(
  candidate: CandidateMessage,
  latest: ConsumedCoordinatorMessage
): boolean {
  if (candidate.sequence <= latest.sequence) {
    return false
  }
  const sameThread =
    candidate.threadId === latest.id ||
    (latest.threadId !== null && candidate.threadId === latest.threadId)
  const parsed = sameThread ? null : parseJsonRecord(candidate.payload)
  return sameThread || parsed?.requestId === latest.id || parsed?.replyTo === latest.id
}

function sentInCurrentLocalTurn(candidate: CandidateMessage, stop: OutboundReportStop): boolean {
  if (stop.turnStartedAfterSequence !== undefined) {
    return candidate.sequence > stop.turnStartedAfterSequence
  }
  return sentInOrAfterTurn(candidate.createdAt, stop.turnStartedAt)
}

function hasRemoteOutboundReport(
  db: OrchestrationDb,
  dispatchId: string,
  stop: OutboundReportStop
): boolean {
  const latest = latestConsumedCoordinatorMessage(db, dispatchId, stop)
  const latestSec = latest ? Math.floor(parseDispatchUtcMs(latest.createdAt) / 1000) : null
  return db.db
    .prepare(
      "SELECT sequence, message_id, kind, created_at FROM federation_relay_items WHERE dispatch_id = ? AND direction = 'to_home' ORDER BY sequence ASC"
    )
    .all(dispatchId)
    .some((row) => {
      const sequence = typeof row.sequence === 'number' ? row.sequence : 0
      const messageId = text(row.message_id) ?? ''
      const kind = text(row.kind) ?? ''
      const createdAt = text(row.created_at) ?? ''
      if (!OUTBOUND_REPORT_TYPES.has(kind) || isSystemReportId(messageId)) {
        return false
      }
      if (latestSec !== null && Math.floor(parseDispatchUtcMs(createdAt) / 1000) < latestSec) {
        return false
      }
      if (stop.turnStartedAfterSequence !== undefined) {
        return sequence > stop.turnStartedAfterSequence
      }
      return sentInOrAfterTurn(createdAt, stop.turnStartedAt)
    })
}

function isSystemReportId(id: string): boolean {
  return SYSTEM_REPORT_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed to non-null non-array object above.
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function sentInOrAfterTurn(createdAt: string, turnStartedAt: number | undefined): boolean {
  if (turnStartedAt === undefined) {
    return false
  }
  return Math.floor(parseDispatchUtcMs(createdAt) / 1000) >= Math.floor(turnStartedAt / 1000)
}
