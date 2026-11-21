import { expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { approvalReportId } from './worker-approval-report'

vi.mock('../../mailbox/routing/structured-session-mail-target', () => ({
  structuredMailboxCustody: () => ({ sessionId: 'session-1', dispatchId: null })
}))

const { ChatWorkerApprovalWatch } = await import('./chat-worker-approval-watch')

it('closes, after a restart, a chat approval Orca answered before its closing line was stored', async () => {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  db.insertMessage({
    id: approvalReportId(dispatch.id, 'item_1', 'open'),
    from: 'term_worker',
    to: `run:${run.id}`,
    subject: 'Worker is waiting for permission',
    type: 'escalation',
    payload: JSON.stringify({
      approval: {
        v: 1,
        approvalId: 'item_1',
        state: 'open',
        worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: dispatch.task_id },
        summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
        allowedActions: ['allow', 'deny']
      }
    }),
    runId: run.id
  })
  const watch = new ChatWorkerApprovalWatch({
    getDb: () => db,
    notify: vi.fn(),
    signal: new AbortController().signal,
    watchJournal: () => () => {},
    // The worker's chat recorded Orca's Allow; Orca quit before writing the closing line.
    readPrompt: async () => ({
      revision: 2,
      body: {
        kind: 'approval',
        title: 'Allow Bash?',
        detail: 'rm -rf build',
        options: [
          { id: 'allow', label: 'Allow', intent: 'allow_once' },
          { id: 'deny', label: 'Deny', intent: 'reject_once' }
        ],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: `trusted-local:orchestration:approval:${dispatch.id}`,
          resolvedAt: 2
        }
      }
    })
  })

  await watch.adopt()

  const closed = db.getMessageById(approvalReportId(dispatch.id, 'item_1', 'closed'))
  expect(JSON.parse(closed?.payload ?? '{}').approval).toMatchObject({
    state: 'answered',
    outcome: { decision: 'allow' }
  })
})
