import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('fleet echo', () => {
    it('orchestration.send carries the fleet block for a point-to-point send', async () => {
      setup()
      vi.spyOn(runtime, 'listTerminalSummariesForHandles').mockResolvedValue([])
      const task = db.createTask({ spec: 'fleet echo work' })
      db.createDispatchContext(task.id, 'term_worker')

      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'hello'
      })) as { fleet?: { runId: string } }

      expect(result.fleet?.runId).toBe(activeRunId)
    })

    it('orchestration.send omits the block when fleet is false', async () => {
      setup()
      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'hello',
        fleet: false
      })) as { fleet?: unknown }

      expect(result.fleet).toBeUndefined()
    })

    it('orchestration.reply carries the fleet block for a direct reply', async () => {
      setup()
      vi.spyOn(runtime, 'listTerminalSummariesForHandles').mockResolvedValue([])
      const original = db.insertMessage({ from: 'term_worker', to: 'term_coord', subject: 'status' })

      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'ack',
        from: 'term_coord'
      })) as { fleet?: { runId: string } }

      expect(result.fleet?.runId).toBe(activeRunId)
    })

    it('orchestration.reply omits the fleet block for a caller outside the message Run', async () => {
      setup()
      vi.spyOn(runtime, 'listTerminalSummariesForHandles').mockResolvedValue([])
      const original = db.insertMessage({ from: 'term_worker', to: 'term_coord', subject: 'status' })

      // Why: a message id alone must not hand out another Run's lane roster.
      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'ack',
        from: 'term_worker'
      })) as { fleet?: unknown }

      expect(result.fleet).toBeUndefined()
    })

    it('orchestration.reply carries the fleet block when answering a question', async () => {
      setup()
      vi.spyOn(runtime, 'listTerminalSummariesForHandles').mockResolvedValue([])
      const task = db.createTask({ spec: 'reply fleet work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      const created = db.createQuestion({
        runId: activeRunId as string,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Proceed?'
      })

      const result = (await call('orchestration.reply', {
        id: created.message.id,
        body: 'yes',
        from: 'term_coord'
      })) as { fleet?: { runId: string } }

      expect(result.fleet?.runId).toBe(activeRunId)
    })
  })
})
