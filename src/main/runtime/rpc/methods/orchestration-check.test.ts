import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import type { OrcaRuntimeService } from '../../orca-runtime'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey, findMethod } = h
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

  describe('orchestration.check', () => {
    function createDispatchedTask(assigneeHandle = 'term_worker', assigneePaneKey?: string) {
      const task = db.createTask({ spec: 'manual check work' })
      const dispatch = db.createDispatchContext(task.id, assigneeHandle, assigneePaneKey)
      return { task, dispatch }
    }

    function insertWorkerDone(params: {
      from?: string
      to?: string
      taskId?: string
      dispatchId?: string
      filesModified?: string[]
      senderPaneKey?: string
    }): void {
      const payload: Record<string, unknown> = {}
      if (params.taskId !== undefined) {
        payload.taskId = params.taskId
      }
      if (params.dispatchId !== undefined) {
        payload.dispatchId = params.dispatchId
      }
      payload.outcome = 'succeeded'
      if (params.filesModified !== undefined) {
        payload.filesModified = params.filesModified
      }

      const message = db.insertMessage({
        from: params.from ?? 'term_worker',
        to: params.to ?? `run:${activeRunId}`,
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify(payload),
        senderPaneKey: params.senderPaneKey,
        runId: activeRunId
      })
      reconcileLifecycleMessage(db, message)
    }

    it('returns unread messages for a terminal', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const result = (await call('orchestration.check', {
        terminal: 'b'
      })) as { messages: unknown[]; count: number }

      expect(result.count).toBe(2)
    })

    it('never mixes two bound Run mailboxes', async () => {
      setup(false)
      const paneA = 'tab_a:11111111-1111-4111-8111-111111111111'
      const paneB = 'tab_b:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_a' ? paneA : paneB
      )
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term_a',
        coordinatorPaneKey: paneA
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term_b',
        coordinatorPaneKey: paneB
      })
      db.insertMessage({
        from: 'worker_a',
        to: `run:${runA.id}`,
        subject: 'A only',
        runId: runA.id
      })
      db.insertMessage({
        from: 'worker_b',
        to: `run:${runB.id}`,
        subject: 'B only',
        runId: runB.id
      })

      const inboxA = (await call('orchestration.check', { terminal: 'term_a' })) as {
        messages: { subject: string }[]
      }
      const inboxB = (await call('orchestration.check', { terminal: 'term_b' })) as {
        messages: { subject: string }[]
      }
      expect(inboxA.messages.map((message) => message.subject)).toEqual(['A only'])
      expect(inboxB.messages.map((message) => message.subject)).toEqual(['B only'])
    })

    it('uses the stable pane identity when the coordinator handle was reminted', async () => {
      setup()
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Completed after restart',
        runId: activeRunId
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_stale_coord',
        terminalPaneKey: coordinatorPaneKey
      })) as { runId: string; messages: { subject: string }[] }

      expect(result).toMatchObject({
        runId: activeRunId,
        messages: [{ subject: 'Completed after restart' }]
      })
    })

    it('keeps a live handle authoritative over mismatched pane metadata', async () => {
      setup()
      const foreignRun = db.createRun({
        objective: 'Foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Coordinator only',
        runId: activeRunId
      })
      db.insertMessage({
        from: 'term_foreign_worker',
        to: `run:${foreignRun.id}`,
        subject: 'Foreign only',
        runId: foreignRun.id
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        terminalPaneKey: 'tab_foreign:leaf_foreign',
        all: true
      })) as { runId: string; messages: { subject: string }[] }

      expect(result.runId).toBe(activeRunId)
      expect(result.messages.map((message) => message.subject)).toEqual(['Coordinator only'])
    })

    it('returns formatted output with --format', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        format: true
      })) as { formatted: string; count: number }

      expect(result.formatted).toContain('Subject: test')
      expect(result.count).toBe(1)
    })

    it('filters by type', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
    })

    it('returns typed timeout and rejects a second actionable waiter', async () => {
      setup()
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValueOnce('timed_out')

      const timedOut = (await call('orchestration.check', {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 10
      })) as { timedOut: boolean; cancelled: boolean; count: number }
      expect(timedOut).toMatchObject({ timedOut: true, cancelled: false, count: 0 })

      vi.mocked(runtime.waitForMessage).mockResolvedValueOnce('waiter_exists')
      await expect(
        call('orchestration.check', {
          terminal: 'term_coord',
          wait: true,
          timeoutMs: 10
        })
      ).rejects.toMatchObject({ code: 'waiter_exists' })
    })

    it('rejects stale Delivery acknowledgment without consuming queued mail', async () => {
      setup()
      db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'queued',
        runId: activeRunId
      })

      await expect(
        call('orchestration.check', {
          terminal: 'term_coord',
          ack: 'delivery_missing'
        })
      ).rejects.toMatchObject({ code: 'stale_delivery' })
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(1)
    })

    it('acknowledges a Run Delivery before returning --peek history', async () => {
      setup()
      db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'queued',
        runId: activeRunId
      })

      const first = (await call('orchestration.check', {
        terminal: 'term_coord'
      })) as { count: number; deliveryId: string }
      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        ack: first.deliveryId,
        peek: true
      })) as { acknowledged: string | null; count: number }

      expect(first.count).toBe(1)
      expect(peeked).toMatchObject({ acknowledged: first.deliveryId, count: 0 })
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(0)
    })

    it('peeks an old unread Run row beyond the newest history page', async () => {
      setup()
      const unread = db.insertMessage({
        from: 'worker',
        to: `run:${activeRunId}`,
        subject: 'old unread',
        runId: activeRunId
      })
      for (let index = 0; index < 100; index += 1) {
        const read = db.insertMessage({
          from: 'worker',
          to: `run:${activeRunId}`,
          subject: `new read ${index}`,
          runId: activeRunId
        })
        db.markAsRead([read.id])
      }

      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        peek: true
      })) as { messages: { id: string }[]; count: number }
      const delivered = (await call('orchestration.check', {
        terminal: 'term_coord'
      })) as { messages: { id: string }[]; count: number }

      expect(peeked).toMatchObject({ count: 1, messages: [{ id: unread.id }] })
      expect(delivered).toMatchObject({ count: 1, messages: [{ id: unread.id }] })
    })

    it('waits for a filtered Run peek without consuming the arrival', async () => {
      setup()
      let arrivedId = ''
      const waitSpy = vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        arrivedId = db.insertMessage({
          from: 'worker',
          to: `run:${activeRunId}`,
          subject: 'peeked completion',
          type: 'worker_done',
          runId: activeRunId
        }).id
        return 'notified'
      })

      const peeked = (await call('orchestration.check', {
        terminal: 'term_coord',
        peek: true,
        wait: true,
        types: 'worker_done',
        timeoutMs: 100
      })) as { messages: { id: string }[]; count: number }

      expect(peeked).toMatchObject({ count: 1, messages: [{ id: arrivedId }] })
      expect(waitSpy).toHaveBeenCalledWith(
        `run:${activeRunId}`,
        expect.objectContaining({ typeFilter: ['worker_done'] })
      )
      expect(db.getMessageById(arrivedId)?.read).toBe(0)
      expect(db.getUnreadMessages(`run:${activeRunId}`, ['worker_done'])).toHaveLength(1)
    })

    it('reconciles worker_done returned by a waiting manual check', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        insertWorkerDone({
          taskId: task.id,
          dispatchId: dispatch.id,
          filesModified: ['src/file.ts']
        })
        return 'notified'
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 100,
        types: 'worker_done,escalation,decision_gate'
      })) as { count: number; messages: { type: string }[]; deliveryId: string }

      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('worker_done')
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(1)
      const taskList = (await call('orchestration.taskList', {})) as {
        tasks: {
          id: string
          status: string
          assignee_handle?: string | null
          dispatch_id?: string | null
        }[]
      }
      const listedTask = taskList.tasks.find((t) => t.id === task.id)
      expect(listedTask?.status).toBe('completed')
      expect(listedTask).not.toHaveProperty('assignee_handle')
      expect(listedTask).not.toHaveProperty('dispatch_id')
      const shownDispatch = (await call('orchestration.dispatchShow', {
        task: task.id
      })) as { dispatch: { status: string } | null }
      expect(shownDispatch.dispatch?.status).toBe('completed')

      const completedAt = db.getTask(task.id)?.completed_at
      const taskResult = db.getTask(task.id)?.result
      const repeated = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number; deliveryId: string }
      expect(repeated.count).toBe(1)
      expect(repeated.deliveryId).toBe(result.deliveryId)
      const acknowledged = (await call('orchestration.check', {
        terminal: 'term_coord',
        ack: repeated.deliveryId,
        types: 'worker_done'
      })) as { count: number }
      expect(acknowledged.count).toBe(0)
      expect(db.getTask(task.id)?.completed_at).toBe(completedAt)
      expect(db.getTask(task.id)?.result).toBe(taskResult)
    })

    it('keeps check --all read-only while lifecycle settles at acceptance', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      insertWorkerDone({ taskId: task.id, dispatchId: dispatch.id })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        all: true,
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getUnreadMessages(`run:${activeRunId}`, ['worker_done'])).toHaveLength(1)
    })

    it('does not complete worker_done missing taskId or dispatchId', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      insertWorkerDone({ dispatchId: dispatch.id })
      insertWorkerDone({ taskId: task.id })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(2)
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    })

    it('completes worker_done by payload IDs when the sender handle changed', async () => {
      setup()
      const leafId = '11111111-1111-4111-8111-111111111111'
      const { task, dispatch } = createDispatchedTask('term_owner', `tab_before:${leafId}`)
      insertWorkerDone({
        from: 'term_reminted',
        taskId: task.id,
        dispatchId: dispatch.id,
        senderPaneKey: `tab_after:${leafId}`
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    })

    it('does not complete worker_done for a stale inactive dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'retry-sensitive work' })
      const staleDispatch = db.createDispatchContext(task.id, 'term_old')
      db.failDispatch(staleDispatch.id, 'retry elsewhere')
      const activeDispatch = db.createDispatchContext(task.id, 'term_current')
      insertWorkerDone({
        from: 'term_old',
        taskId: task.id,
        dispatchId: staleDispatch.id
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(staleDispatch.id)?.status).toBe('failed')
      expect(db.getDispatchContextById(activeDispatch.id)?.status).toBe('dispatched')
    })

    it('returns a persisted foreign completion as a rejection diagnostic', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask('term_worker', 'tab_worker:leaf_worker')
      insertWorkerDone({
        from: 'term_foreign',
        taskId: task.id,
        dispatchId: dispatch.id,
        senderPaneKey: 'tab_foreign:leaf_foreign'
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number; messages: { type: string; subject: string; body: string }[] }

      expect(result).toMatchObject({
        count: 1,
        messages: [
          {
            type: 'worker_done',
            subject: 'Rejected worker_done: Done',
            body: expect.stringContaining('expected handle term_worker')
          }
        ]
      })
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    })

    it('records heartbeat returned by unread manual check', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      const msg = db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
        runId: activeRunId
      })
      reconcileLifecycleMessage(db, msg)

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'heartbeat'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBe(msg.created_at)
    })

    it('rejects invalid type filters', async () => {
      setup()
      await expect(
        call('orchestration.check', {
          terminal: 'b',
          types: 'worker_done,typo'
        })
      ).rejects.toThrow('Invalid --types')
    })

    it('rejects conflicting message read modes', () => {
      const method = findMethod('orchestration.check')
      expect(() => method.params!.parse({ unread: true, peek: true })).toThrow(/read mode/)
    })

    it('default (unread only) marks returned rows as read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })

      const first = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(first.count).toBe(2)

      const second = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(second.count).toBe(0)
    })

    it('--peek returns unread messages without marking them read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it("treats the CLI's {peek, unread:false} compat pair as peek, not all", async () => {
      setup()
      const seen = db.insertMessage({ from: 'a', to: 'b', subject: 'seen' })
      db.markAsRead([seen.id])
      db.insertMessage({ from: 'a', to: 'b', subject: 'fresh' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true,
        unread: false
      })) as { messages: { subject: string }[]; count: number }

      expect(result.count).toBe(1)
      expect(result.messages[0]?.subject).toBe('fresh')
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('--all returns every message for the handle without marking read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      const second = db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.markAsRead([second.id])

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { read: number }[]; count: number }

      expect(result.count).toBe(2)
      // Must not have flipped the remaining unread row
      const stillUnread = db.getUnreadMessages('b')
      expect(stillUnread).toHaveLength(1)
    })

    it('--all applies type filters without marking rows as read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'dispatch', type: 'dispatch' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true,
        types: 'worker_done,dispatch'
      })) as { messages: { type: string }[]; count: number }

      expect(result.count).toBe(2)
      expect(result.messages.map((m) => m.type).sort()).toEqual(['dispatch', 'worker_done'])
      expect(db.getUnreadMessages('b')).toHaveLength(3)
    })

    it('--all returns rows with delivered_at set after push-on-idle stamped them', async () => {
      setup()
      const msg = db.insertMessage({ from: 'a', to: 'b', subject: 'hi' })
      // Why: simulate push-on-idle stamping delivered_at without the runtime loop.
      db.markAsDelivered([msg.id])

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { id: string; delivered_at: string | null }[]; count: number }

      expect(result.count).toBe(1)
      expect(result.messages[0].delivered_at).not.toBeNull()
    })

    it('--all --terminal <unknown> returns empty list', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'does_not_exist',
        all: true
      })) as { count: number }
      expect(result.count).toBe(0)
    })

    it('unread:false compat shim behaves like --all (one-release bridge)', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        unread: false
      })) as { count: number }
      expect(result.count).toBe(1)

      // Must not have marked read
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('does not mark messages read when a waiting check is aborted', async () => {
      setup()
      const abortController = new AbortController()
      ctx = { runtime, signal: abortController.signal }
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        db.insertMessage({ from: 'a', to: 'b', subject: 'arrived during close' })
        abortController.abort()
        return 'cancelled'
      })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('keeps waiting for requested types when an unrelated status arrives', async () => {
      setup()
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'coord' ? 'tab_wait:leaf_wait' : null
      )

      const waitPromise = call('orchestration.check', {
        terminal: 'coord',
        wait: true,
        timeoutMs: 5000,
        types: 'escalation,question'
      }) as Promise<{ count: number; messages: { type: string }[] }>
      await Promise.resolve()

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'still working',
        type: 'status',
        run: activeRunId
      })

      const early = await Promise.race([
        waitPromise.then(() => 'settled'),
        Promise.resolve('pending')
      ])
      expect(early).toBe('pending')

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'needs attention',
        type: 'question',
        run: activeRunId
      })

      const result = await waitPromise
      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('question')
    })

    it('does not mark existing messages read when the check starts aborted', async () => {
      setup()
      const abortController = new AbortController()
      abortController.abort()
      ctx = { runtime, signal: abortController.signal }
      db.insertMessage({ from: 'a', to: 'b', subject: 'already unread' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })
  })

  describe('orchestration.inbox', () => {
    it('returns all messages', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

      const result = (await call('orchestration.inbox', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('--terminal <handle> matches check --all output for the same handle', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const inbox = (await call('orchestration.inbox', { terminal: 'b' })) as {
        messages: { id: string; to_handle: string }[]
        count: number
      }
      const check = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { id: string; to_handle: string }[]; count: number }

      expect(inbox.count).toBe(2)
      expect(check.count).toBe(2)
      // Same rows in the same order — both use sequence DESC
      expect(inbox.messages.map((m) => m.id)).toEqual(check.messages.map((m) => m.id))
      expect(inbox.messages.every((m) => m.to_handle === 'b')).toBe(true)
    })

    it('--terminal <unknown_handle> returns empty list without erroring', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.inbox', {
        terminal: 'does_not_exist'
      })) as { count: number }
      expect(result.count).toBe(0)
    })
  })
})
