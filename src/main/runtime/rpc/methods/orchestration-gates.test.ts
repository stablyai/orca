import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { findMethod } = h
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

    it('rejects invalid options JSON', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: 'not-json'
        })
      ).rejects.toThrow('Invalid --options')
    })

    it('rejects options that are not string arrays', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: JSON.stringify(['yes', 1])
        })
      ).rejects.toThrow('Invalid --options')
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

    it('throws on nonexistent gate', async () => {
      setup()
      await expect(
        call('orchestration.gateResolve', { id: 'gate_fake', resolution: 'yes' })
      ).rejects.toThrow('Gate not found')
    })
  })

  describe('orchestration.gateList', () => {
    it('lists all gates', async () => {
      setup()
      const t1 = db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.createGate({ taskId: t1.id, question: 'q1' })
      db.createGate({ taskId: t2.id, question: 'q2' })

      const result = (await call('orchestration.gateList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const gate = db.createGate({ taskId: task.id, question: 'q' })
      db.resolveGate(gate.id, 'yes')

      const result = (await call('orchestration.gateList', {
        status: 'resolved'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.gateList')
      expect(() => method.params!.parse({ status: 'closed' })).toThrow()
    })
  })
})
