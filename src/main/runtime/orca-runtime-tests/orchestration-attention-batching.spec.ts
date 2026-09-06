import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  OrchestrationDb,
  createRootDispatch,
  makePaneKey
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('batches attention queries across unchanged graph publishes', () => {
    const runtime = new OrcaRuntimeService(store)
    const terminals = Array.from({ length: 12 }, (_, index) => ({
      tabId: `tab-attention-batch-${index}`,
      leafId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ptyId: `pty-attention-batch-${index}`,
      paneRuntimeId: index + 1
    }))
    const handles = terminals.map((terminal) => runtime.preAllocateHandleForPty(terminal.ptyId))
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'bounded attention query oracle',
        coordinatorHandle: 'term_attention_coordinator',
        coordinatorPaneKey: makePaneKey(
          'tab-attention-coordinator',
          '20000000-0000-4000-8000-000000000000'
        )
      })
      for (const [index, terminal] of terminals.entries()) {
        const task = db.createTask({ spec: `worker ${index}`, runId: run.id })
        createRootDispatch(
          db,
          task.id,
          handles[index],
          makePaneKey(terminal.tabId, terminal.leafId)
        )
      }
      const getWorkerAttentionFacts = vi.spyOn(db, 'getWorkerAttentionFacts')
      const prepare = vi.spyOn(db.db, 'prepare')
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)
      const graph = {
        tabs: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: terminal.tabId,
          activeLeafId: terminal.leafId,
          layout: null
        })),
        leaves: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: terminal.leafId,
          paneRuntimeId: terminal.paneRuntimeId,
          ptyId: terminal.ptyId,
          paneTitle: null
        }))
      }

      runtime.syncWindowGraph(1, graph)
      prepare.mockClear()
      getWorkerAttentionFacts.mockClear()
      const unchanged = runtime.syncWindowGraph(1, graph)

      // Two statements for twelve panes: the facts join and the observation read, each once.
      const attentionSql = prepare.mock.calls
        .map(([sql]) => sql)
        .filter(
          (sql) =>
            (sql.includes('AS pending_input') && sql.includes('json_each(?)')) ||
            (sql.includes('attempt_observation_facts') && sql.includes('json_each(?)'))
        )
      expect(Object.keys(unchanged.agentOrchestrationByPaneKey ?? {})).toHaveLength(12)
      expect(getWorkerAttentionFacts).not.toHaveBeenCalled()
      expect(attentionSql).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})
