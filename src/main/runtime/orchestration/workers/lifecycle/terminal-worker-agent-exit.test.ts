import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { createTranscriptPane } from '../../../terminal/wait/agent-transcript-pane-test-harness'
import { OrchestrationDb } from '../../db/orchestration-db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

async function startWorkerPane() {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Worker',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    data: ''
  })
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey,
    processIncarnation: 'inc-1',
    worktreeId: 'wt-1',
    effects: [],
    setupState: 'skipped'
  })
  db.markWorkerDispatchReady(dispatch.id)
  runtime.setOrchestrationDb(db)
  // The hook server proved the pane's agent ended: its process gone, or its shell alone.
  const agentExited = () => runtime.observeWorkerAgentExit(paneKey)
  const escalations = () =>
    db.getUnreadRunMailbox(run.id, 100, ['escalation']).map((message) => ({
      subject: message.subject,
      body: message.body
    }))
  return {
    db,
    agentExited,
    escalations,
    handle,
    paneKey,
    runId: run.id,
    taskId: task.id,
    dispatchId: dispatch.id
  }
}

describe('a terminal worker whose agent exits while its terminal stays open', () => {
  it('fails the dispatch and tells the coordinator once', async () => {
    const { db, agentExited, escalations, dispatchId } = await startWorkerPane()
    try {
      agentExited()
      // The same end proven again is not news.
      agentExited()
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
      expect(escalations()).toEqual([
        {
          subject: 'Worker exited without reporting',
          body: expect.stringContaining(
            'exited (its agent exited; its terminal is still open) without sending worker_done'
          )
        }
      ])
    } finally {
      // Escalation mail is delivered after the settlement commits.
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  })

  it('says nothing when the agent exits after worker_done', async () => {
    const { db, agentExited, escalations, handle, paneKey, runId, taskId, dispatchId } =
      await startWorkerPane()
    try {
      const done = db.insertMessage({
        from: handle,
        to: `run:${runId}`,
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' }),
        runId,
        senderPaneKey: paneKey
      })
      reconcileLifecycleMessage(db, done)
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')

      agentExited()
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
      expect(escalations()).toEqual([])
    } finally {
      // Escalation mail is delivered after the settlement commits.
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  })
})
