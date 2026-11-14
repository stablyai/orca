import { describe, expect, it, vi } from 'vitest'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import { OrchestrationDb } from '../db/orchestration-db'

const TERMINAL_WORKER_HANDLE = 'term_worker'
const TERMINAL_WORKER_PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

describe('keyed orchestration presentation', () => {
  it('reads current task facts across commits, rollback and completion expiry', () => {
    const db = new OrchestrationDb(':memory:')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-09T12:00:00Z'))
    try {
      const run = db.createRun({
        objective: 'Keyed presentation',
        coordinatorHandle: 'coordinator',
        coordinatorPaneKey: null
      })
      const task = db.createTask({ runId: run.id, spec: 'Original title' })
      const dispatch = db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: TERMINAL_WORKER_HANDLE,
        assigneePaneKey: TERMINAL_WORKER_PANE,
        creator: { kind: 'system' },
        maxDepth: 99
      })
      const projection = new RuntimeAgentOrchestrationProjection({
        getDb: () => db,
        getLeaves: () => [],
        getPtys: () => [],
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        issueLeafHandle: () => '',
        issuePtyHandle: () => '',
        makePaneKey: () => '',
        getWorktreeId: (handle) => (handle === TERMINAL_WORKER_HANDLE ? 'folder:/workspace' : null),
        getHandleForPaneKey: (pane) =>
          pane === TERMINAL_WORKER_PANE ? TERMINAL_WORKER_HANDLE : null,
        getPaneKey: (handle) => (handle === TERMINAL_WORKER_HANDLE ? TERMINAL_WORKER_PANE : null),
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getAgentStatusForPaneKey: () => [],
        getSessionRecords: () => null
      })
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Original title')
      db.db.prepare('UPDATE tasks SET task_title = ? WHERE id = ?').run('Committed title', task.id)
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Committed title')
      expect(() =>
        runLifecycleWriteTransaction(db.db, 'projection_rollback', () => {
          db.db
            .prepare('UPDATE tasks SET task_title = ? WHERE id = ?')
            .run('Rolled back title', task.id)
          expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe(
            'Rolled back title'
          )
          throw new Error('rollback')
        })
      ).toThrow('rollback')
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.taskTitle).toBe('Committed title')
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'completed', completed_at = ? WHERE id = ?")
        .run('2026-11-09 12:00:00', dispatch.id)
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.dispatchStatus).toBe('completed')
      clock.mockReturnValue(Date.parse('2026-11-10T12:00:00Z'))
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)).toBeUndefined()
      clock.mockReturnValue(Date.parse('2026-11-09T12:00:00Z'))
      expect(projection.getForPaneKey(TERMINAL_WORKER_PANE)?.dispatchId).toBe(dispatch.id)
    } finally {
      db.close()
      clock.mockRestore()
    }
  })
})
