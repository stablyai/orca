import { afterEach, describe, expect, it, vi } from 'vitest'

import 'zod'
import type { RpcContext } from '../../../core'

import { createOrchestrationRpcHarness } from '../rpc-test-harness'

import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

import type { OrcaRuntimeService } from '../../../../orca-runtime'

import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
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

  describe('orchestration.send', () => {
    it('wakes the Run mailbox after canonicalizing an old coordinator recipient', async () => {
      setup()
      const remintedPaneKey = 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_reminted'
          ? remintedPaneKey
          : handle === 'term_coord'
            ? coordinatorPaneKey
            : null
      )
      db.bindRun({
        runId: activeRunId!,
        coordinatorHandle: 'term_reminted',
        coordinatorPaneKey: remintedPaneKey
      })
      const waiting = runtime.waitForMessage(`run:${activeRunId}`, { timeoutMs: 5_000 })

      const result = (await call('orchestration.send', {
        from: 'term_reminted',
        to: 'term_coord',
        subject: 'late completion'
      })) as { message: { to_handle: string } }

      expect(result.message.to_handle).toBe(`run:${activeRunId}`)
      await expect(waiting).resolves.toBeInstanceOf(MessageWake)
    })

    it('routes exact Dispatch mail independently of terminal handles', async () => {
      setup()
      const task = db.createTask({ spec: 'controlled worker' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')

      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'Pause after this step'
      })) as { message: { to_handle: string; run_id: string } }

      expect(result.message).toMatchObject({
        to_handle: `dispatch:${dispatch.id}`,
        run_id: activeRunId
      })

      const workerCheck = (await call('orchestration.check', {
        terminal: 'term_worker'
      })) as { dispatchId: string; messages: { subject: string }[] }
      expect(workerCheck).toMatchObject({
        dispatchId: dispatch.id,
        messages: [{ subject: 'Pause after this step' }]
      })
    })

    it('routes Dispatch mail by stable pane identity after worker handle remint', async () => {
      setup()
      const task = db.createTask({ spec: 'controlled worker after restart' })
      const dispatch = createRootDispatch(
        db,
        task.id,
        'term_worker_before',
        'tab_worker:leaf_worker'
      )
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'Continue after restart',
        runId: activeRunId
      })

      const workerCheck = (await call('orchestration.check', {
        terminal: 'term_worker_after',
        terminalPaneKey: 'tab_worker:leaf_worker'
      })) as { dispatchId: string; messages: { subject: string }[] }

      expect(workerCheck).toMatchObject({
        dispatchId: dispatch.id,
        messages: [{ subject: 'Continue after restart' }]
      })
    })

    it('rejects hidden task-recipient retargeting', async () => {
      setup()
      await expect(
        call('orchestration.send', {
          from: 'term_coord',
          to: 'task:task_1',
          subject: 'ambiguous'
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    })

    it('stores the runtime-observed sender pane key on the message row', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_runtime:leaf_runtime')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: 'term_b',
        subject: 'hello',
        senderPaneKey: 'tab_a:leaf_a'
      })) as { message: { id: string } }

      expect(db.getMessageById(result.message.id)?.sender_pane_key).toBe('tab_runtime:leaf_runtime')
    })

    it('rejects a current process whose terminal now resolves to another pane', async () => {
      setup()
      const task = db.createTask({ spec: 'pane-bound manual work' })
      const dispatch = createRootDispatch(
        db,
        task.id,
        'term_worker',
        'tab_worker:leaf_worker',
        undefined,
        'runtime_test:term_worker:1'
      )
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_foreign:leaf_foreign' : coordinatorPaneKey
      )

      expect(
        await call('orchestration.send', {
          from: 'term_worker',
          subject: 'Done',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        })
      ).toMatchObject({ lifecycle: { action: 'rejected', code: 'worker_identity_changed' } })
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    })

    it('rejects an identity-less lifecycle send resolved through the coordinator handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dependent = db.createTask({ spec: 'dependent', deps: [task.id] })
      const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_coord' ? 'tab_coord:leaf_coord' : null
      )
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_coord',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getTask(dependent.id)?.status).toBe('pending')
    })

    it('ignores caller-supplied pane claims and uses the runtime-observed pane', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        senderPaneKey: 'tab_foreign:leaf_foreign',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      })) as {
        message: { id: string; type: string; subject: string }
        lifecycle: { action: string; code: string; reason: string }
      }

      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(result.lifecycle).toMatchObject({ action: 'completed' })
      expect(result.message).toMatchObject({
        type: 'worker_done',
        subject: 'Done'
      })
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toEqual([
        expect.objectContaining({ id: result.message.id, type: 'worker_done' })
      ])
      expect(runtime.notifyMessageArrived).toHaveBeenCalledWith(`run:${activeRunId}`, 'worker_done')
    })

    it('does not wake waiters for a heartbeat suppressed at send time', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      db.updateTaskStatus(task.id, 'completed')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId: dispatch.id })
      })) as { message: { id: string } }

      expect(notify).not.toHaveBeenCalled()
      expect(db.getMessageById(result.message.id)).toMatchObject({ read: 1 })
    })

    it('releases dispatch lock before waking recipients when worker_done is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'lock-release work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')

      // Waiter notification must observe the committed Dispatch lifecycle.
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {
        expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
      })

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      })) as { message: { type: string } }

      expect(result.message.type).toBe('worker_done')
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
      const t2 = db.createTask({ spec: 'follow-up work' })
      expect(() => createRootDispatch(db, t2.id, 'term_worker')).not.toThrow()
    })

    it('does not release dispatch lock for non-lifecycle sends', async () => {
      setup()
      const task = db.createTask({ spec: 'in-flight work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_coord',
        to: 'term_worker',
        subject: 'how is it going?',
        type: 'status'
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeDefined()
    })
  })
})
