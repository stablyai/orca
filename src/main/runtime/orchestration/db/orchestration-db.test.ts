import { afterEach, describe, expect, it } from 'vitest'

import { OrchestrationDb } from './orchestration-db'
import './contract-constants'
import './messages/mailbox-routing-page'
import './dispatch-row-writer'
import './attempt-outcome-projection'

import { createRootDispatch } from './root-dispatch-test-fixture'

const runId = 'run_legacy_local'

describe('OrchestrationDb', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('tasks', () => {
    it('completing a task frees its active dispatch context', () => {
      const d = createDb()
      const task = d.createTask({ runId, spec: 'do it' })
      createRootDispatch(d, task.id, 'term_a')

      d.updateTaskStatus(task.id, 'completed')

      expect(d.getActiveDispatchForTerminal('term_a')).toBeUndefined()
      expect(d.getDispatchContext(task.id)?.status).toBe('completed')
    })
  })

  describe('dispatch contexts', () => {
    // Only the leaf UUID survives pane break-out; the tab portion of paneKey can change.
    const LEAF_A = '11111111-1111-1111-8111-111111111111'

    it('rejects dispatch when pane keys share a leaf after break-out', () => {
      const d = createDb()
      const t1 = d.createTask({ runId, spec: 'first' })
      const t2 = d.createTask({ runId, spec: 'second' })
      createRootDispatch(d, t1.id, 'term_old', `tab_1:${LEAF_A}`)

      expect(() => createRootDispatch(d, t2.id, 'term_new', `tab_2:${LEAF_A}`)).toThrow(
        /already has an active dispatch/
      )
    })
  })

  describe('decision gates', () => {
    it('rolls back the gate row when the Task transition cannot commit', () => {
      const d = createDb()
      const task = d.createTask({ runId: 'run_legacy_local', spec: 'atomic gate creation' })
      const dispatch = createRootDispatch(d, task.id, 'term_gate')
      d.db.exec(`
        CREATE TRIGGER reject_gate_task_block
        BEFORE UPDATE ON tasks
        WHEN NEW.status = 'blocked'
        BEGIN SELECT RAISE(ABORT, 'forced gate task block failure'); END;
      `)

      expect(() => d.createGate({ taskId: task.id, question: 'Proceed?' })).toThrow(
        'forced gate task block failure'
      )
      expect(d.listGates({ taskId: task.id })).toHaveLength(0)
      expect(d.getTask(task.id)?.status).toBe('dispatched')
      expect(d.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    })
  })
})
