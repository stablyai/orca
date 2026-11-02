import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  function setup(withBoundRun = true): void {
    ;({ db, ctx } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('orchestration.gateCreate', () => {
    it('creates a decision gate and blocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })

      const result = (await call('orchestration.gateCreate', {
        task: task.id,
        question: 'Proceed with migration?',
        options: JSON.stringify(['yes', 'no', 'defer'])
      })) as { gate: { id: string; task_id: string; status: string } }

      expect(result.gate.id).toMatch(/^gate_/)
      expect(result.gate.task_id).toBe(task.id)
      expect(result.gate.status).toBe('pending')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('blocked')
    })

    it('refuses a foreign Run task when no legacy adoption exists', async () => {
      setup()
      expect(db.getLegacyAdoption()).toBeUndefined()
      const callerRun = db.getCurrentRunForPane(h.coordinatorPaneKey)
      if (!callerRun) {
        throw new Error('Expected the caller to have a bound Run')
      }
      const foreignRun = db.createRun({
        objective: 'foreign work',
        coordinatorHandle: 'term_foreign_coord',
        coordinatorPaneKey: 'tab_foreign:77777777-7777-4777-8777-777777777777'
      })
      const foreignTask = db.createTask({ spec: 'foreign assignment', runId: foreignRun.id })

      await expect(
        call('orchestration.gateCreate', {
          task: foreignTask.id,
          question: 'Proceed?',
          from: 'term_coord'
        })
      ).rejects.toMatchObject({
        code: 'task_not_found',
        message: `Task ${foreignTask.id} was not found in Run ${callerRun.id}.`
      })
      expect(db.getTask(foreignTask.id)?.status).toBe('ready')
      expect(db.listGates({ taskId: foreignTask.id })).toHaveLength(0)
    })
  })

  describe('orchestration.gateResolve', () => {
    it('resolves a gate and unblocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })
      const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })

      const result = (await call('orchestration.gateResolve', {
        id: gate.id,
        resolution: 'yes'
      })) as { gate: { id: string; status: string; resolution: string } }

      expect(result.gate.status).toBe('resolved')
      expect(result.gate.resolution).toBe('yes')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('ready')
    })
  })
})
