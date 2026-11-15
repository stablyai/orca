import { expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { approvalReportId, recentOpenApprovalReports } from './worker-approval-report'

it('finds an approval still open behind many newer ones that already closed', () => {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  const report = (approvalId: string, kind: 'open' | 'closed') =>
    db.insertMessage({
      id: approvalReportId(dispatch.id, approvalId, kind),
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: approvalId,
      type: kind === 'open' ? 'escalation' : 'status',
      payload: JSON.stringify({
        approval: {
          v: 1,
          approvalId,
          state: kind === 'open' ? 'open' : 'expired',
          worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: dispatch.task_id },
          summary: { title: 'Allow Bash?', detail: null, reason: null },
          allowedActions: kind === 'open' ? ['allow', 'deny'] : []
        }
      }),
      runId: run.id
    })

  report('apr_still_open', 'open')
  for (let i = 0; i < 250; i++) {
    report(`apr_${i}`, 'open')
    report(`apr_${i}`, 'closed')
  }

  expect(recentOpenApprovalReports(db).map(({ approval }) => approval.approvalId)).toEqual([
    'apr_still_open'
  ])
})
