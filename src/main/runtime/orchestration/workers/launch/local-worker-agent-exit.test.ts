import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../../terminal/wait/agent-transcript-pane-test-harness'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

const AGENT_TITLE = '\x1b]0;✳ Claude Code\x07'
const SHELL_TITLE = '\x1b]0;zsh\x07'

async function startLiveWorker(presence: () => 'live' | 'exited') {
  const { runtime, handle } = await createTranscriptPane(
    {
      paneTitle: 'Worker',
      foregroundProcess: 'codex',
      launchAgent: 'codex',
      data: ''
    },
    {
      checkHookAgentPresence: async () => presence()
    }
  )
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
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey: makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111'),
    processIncarnation: 'inc-1',
    worktreeId: 'wt-1',
    effects: [],
    setupState: 'skipped'
  })
  db.markWorkerDispatchReady(dispatch.id)
  runtime.setOrchestrationDb(db)
  return { runtime, handle, db, runId: run.id, dispatchId: dispatch.id }
}

async function returnToShell(runtime: { onPtyData: (ptyId: string, data: string, at: number) => void }) {
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, AGENT_TITLE, 100)
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, SHELL_TITLE, 101)
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('local worker whose agent process ends while the terminal stays open', () => {
  it('keeps the dispatch when the hook still proves the agent process is live', async () => {
    const started = await startLiveWorker(() => 'live')
    try {
      await returnToShell(started.runtime)
      expect(started.db.getDispatchContextById(started.dispatchId)?.status).toBe('dispatched')
    } finally {
      started.db.close()
    }
  })

  it('escalates once the shell returns and the hook proves the agent process is gone', async () => {
    const started = await startLiveWorker(() => 'exited')
    try {
      await returnToShell(started.runtime)
      const escalations = started.db.getUnreadRunMailbox(started.runId, 100, ['escalation'])
      const payload = escalations[0]?.payload ? JSON.parse(escalations[0].payload) : null
      expect({
        dispatch: started.db.getDispatchContextById(started.dispatchId)?.status,
        worker: started.db.getWorkerDispatch(started.dispatchId)?.state,
        subject: escalations.map((message) => message.subject),
        stopReason: payload?.stopReason ?? null,
        terminalStillOpen: Boolean(await started.runtime.readTerminal(started.handle))
      }).toEqual({
        dispatch: 'failed',
        worker: 'failed',
        subject: ['Worker exited without reporting'],
        stopReason: 'exited',
        terminalStillOpen: true
      })
    } finally {
      started.db.close()
    }
  })
})
