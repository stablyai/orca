/** Approvals as Orca's own stop reports stored them. Only a row whose id is the report's stable id
 *  for that approval counts: a worker's `send` can carry any payload, but cannot choose a message id. */
import { z } from 'zod'
import {
  WorkerApprovalPayloadSchema,
  type WorkerApprovalOutcome,
  type WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import {
  reportWorkerApprovalClosed,
  stopReportId,
  type WorkerTurnStopReportDeps
} from '../turn-stops/worker-turn-stop-report'
import { closedApproval } from './worker-approval'

/** A Claude terminal worker's approval id; a chat worker's is its journal item id. */
export const TERMINAL_APPROVAL_ID_PREFIX = 'apr_'

export type ApprovalReportKind = 'open' | 'closed' | 'refined'

export function approvalReportId(
  dispatchId: string,
  approvalId: string,
  kind: ApprovalReportKind
): string {
  return stopReportId(dispatchId, `approval:${approvalId}${kind === 'open' ? '' : `:${kind}`}`)
}

const Carrier = z.object({ approval: WorkerApprovalPayloadSchema })

/** The approval a stored row carries, when Orca's own report wrote it; null for anything else. */
export function readApprovalReport(row: {
  id: string
  payload: string | null
}): WorkerApprovalPayload | null {
  const carried = Carrier.safeParse(parseJson(row.payload))
  if (!carried.success) {
    return null
  }
  const { approval } = carried.data
  const own = (['open', 'closed', 'refined'] as const).some(
    (kind) => approvalReportId(approval.worker.dispatchId, approval.approvalId, kind) === row.id
  )
  return own ? approval : null
}

// Why a bound: older escalations are long past any worker's wait.
const RECENT_ESCALATIONS = 200

/** Recent approvals Orca reported open, with the Dispatch each belongs to; a later close may exist. */
export function recentOpenApprovalReports(
  db: OrchestrationDb
): { approval: WorkerApprovalPayload; dispatch: DispatchContextRow; from: string }[] {
  const rows = z
    .object({ id: z.string(), payload: z.string().nullable(), from_handle: z.string() })
    .array()
    .parse(
      db.db
        .prepare(`SELECT id, payload, from_handle FROM messages WHERE type = 'escalation'
          AND json_valid(payload) AND json_extract(payload, '$.approval.state') = 'open'
          ORDER BY sequence DESC LIMIT ${RECENT_ESCALATIONS}`)
        .all()
    )
  return rows.flatMap((row) => {
    const approval = readApprovalReport(row)
    const dispatch = approval ? db.getDispatchContextById(approval.worker.dispatchId) : undefined
    return approval && dispatch ? [{ approval, dispatch, from: row.from_handle }] : []
  })
}

/** Closes an approval Orca reported, from its stored escalation; a no-op once a close exists. */
export function closeReportedApproval(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  approvalId: string,
  outcome: WorkerApprovalOutcome,
  deps: Pick<WorkerTurnStopReportDeps, 'notify'>
): void {
  const row = db.getMessageById(approvalReportId(dispatch.id, approvalId, 'open'))
  const open = row ? readApprovalReport(row) : null
  if (!row || !open) {
    return
  }
  reportWorkerApprovalClosed(
    db,
    dispatch,
    { from: row.from_handle, approval: closedApproval(open, outcome) },
    deps
  )
}

function parseJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}
