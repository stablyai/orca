/** A terminal worker's prompt is answerable only while Orca holds its hook, and holds live in
 *  memory: after a restart, a prompt still open in the mailbox can no longer be answered here. */
import { z } from 'zod'
import { WorkerApprovalPayloadSchema } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { reportWorkerApprovalClosed } from '../turn-stops/worker-turn-stop-report'

// Why a bound: older escalations are long past Claude's own 2:00 timeout.
const RECENT_ESCALATIONS = 200

const Row = z.object({ payload: z.string() })
const Carrier = z.object({
  handle: z.string(),
  dispatchId: z.string(),
  approval: WorkerApprovalPayloadSchema
})

/** Closes every open terminal-worker prompt, so its card becomes a receipt; a prompt already
 *  closed keeps its line, since the closing report's id is fixed per prompt. */
export function closeOrphanedTerminalApprovals(db: OrchestrationDb): void {
  const rows = Row.array().parse(
    db.db
      .prepare(`SELECT payload FROM messages WHERE type = 'escalation'
        AND json_extract(payload, '$.approval.state') = 'open'
        AND json_extract(payload, '$.approval.approvalId') LIKE 'apr\\_%' ESCAPE '\\'
        ORDER BY sequence DESC LIMIT ${RECENT_ESCALATIONS}`)
      .all()
  )
  for (const row of rows) {
    const carried = Carrier.safeParse(parseJson(row.payload))
    const dispatch = carried.success ? db.getDispatchContextById(carried.data.dispatchId) : null
    if (!carried.success || !dispatch) {
      continue
    }
    const { approval, handle } = carried.data
    reportWorkerApprovalClosed(
      db,
      dispatch,
      {
        from: handle,
        approval: {
          ...approval,
          state: 'expired',
          allowedActions: [],
          outcome: { by: 'unknown', decision: null, reason: null, reasonDelivered: true }
        }
      },
      // Nothing to wake: the coordinator reads it with its next mail.
      { notify: () => {} }
    )
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
