import { describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'

const CHAT_SESSION_ID = testOrcaSessionId('3a5c7e9b-1d4f-4a6c-8b0e-2f4a6c8e0b14')

describe('OrcaRuntimeService', () => {
  it("nests a native chat's workers under the chat's status pane", async () => {
    const runtime = new OrcaRuntimeService(store)
    const worker = {
      tabId: 'tab-chat-worker',
      leafId: '30000000-0000-4000-8000-000000000001',
      ptyId: 'pty-chat-worker'
    }
    const workerHandle = runtime.preAllocateHandleForPty(worker.ptyId)
    const workerPaneKey = makePaneKey(worker.tabId, worker.leafId)
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'chat coordinator',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: CHAT_SESSION_ID
      })
      const task = db.createTask({ spec: 'worker', runId: run.id })
      createRootDispatch(db, task.id, workerHandle, workerPaneKey)
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)

      const result = await runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: worker.tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Claude Code',
            activeLeafId: worker.leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: worker.tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: worker.leafId,
            paneRuntimeId: 1,
            ptyId: worker.ptyId,
            paneTitle: null
          }
        ]
      })

      expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toMatchObject({
        orchestrationRunId: run.id,
        parentPaneKey: structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(CHAT_SESSION_ID),
          CHAT_SESSION_ID
        )
      })
    } finally {
      db.close()
    }
  })
})
