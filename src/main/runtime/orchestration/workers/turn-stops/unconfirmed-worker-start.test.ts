import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { observeUnconfirmedWorkerStart } from './unconfirmed-worker-start'

describe('an unconfirmed chat worker start', () => {
  it('says to check the chat, not to press Enter in a terminal', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'chat start',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
    })
    const task = db.createTask({ spec: 'do the work', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.markWorkerStartUnknown(dispatch.id, 'turn_start_unobserved', 'pending')
    const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }

    observeUnconfirmedWorkerStart(db, dispatch.id, { surface: 'chat' }, deps)
    observeUnconfirmedWorkerStart(db, dispatch.id, { surface: 'chat' }, deps)

    const mail = db.getUnreadRunMailbox(run.id, 100, ['escalation'])
    expect(mail.map((message) => message.subject)).toEqual([
      "Worker's brief may not have been submitted"
    ])
    expect(mail[0]?.body).toContain(`\`orchestration worker-show --dispatch ${dispatch.id}\``)
    expect(mail[0]?.body).not.toContain('terminal send')
  })
})
