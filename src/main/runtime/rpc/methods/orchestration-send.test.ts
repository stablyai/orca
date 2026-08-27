import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext, RpcRequest } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

function lifecycleGroupRecipientError(
  type: 'worker_done' | 'heartbeat' | 'escalation' | 'decision_gate'
): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

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

  function makeRequest(method: string, params: Record<string, unknown>): RpcRequest {
    return {
      id: 'req_1',
      authToken: 'token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    }
  }

  describe('orchestration.send', () => {
    it('sends a message', async () => {
      setup()
      // Why: send notifies arrival so already-idle recipients get push-on-idle
      // delivery without waiting for a status transition (#12536).
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'hello'
      })) as { message: { id: string; from_handle: string; run_id: string } }

      expect(result.message.id).toMatch(/^msg_/)
      expect(result.message.from_handle).toBe('term_coord')
      expect(result.message.run_id).toBe(activeRunId)
      expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalled()
    })

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
      await expect(waiting).resolves.toBe('notified')
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

    it('recovers missing sender pane identity from the resolved handle', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'hello'
      })) as { message: { id: string } }

      expect(runtime.getTerminalPaneKey).toHaveBeenCalledWith('term_worker')
      expect(db.getMessageById(result.message.id)?.sender_pane_key).toBe('tab_worker:leaf_worker')
    })

    it('completes an identity-less injected send through its explicit worker handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
      )
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      const result = await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      })

      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(result).toMatchObject({ lifecycle: { action: 'completed' } })
    })

    it('fences a replacement process for a capability-less manual Dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'process-bound manual work' })
      const dispatch = createRootDispatch(
        db,
        task.id,
        'term_worker',
        'tab_worker:leaf_worker',
        undefined,
        'runtime_test:term_worker:1'
      )
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )
      vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:2')
      const payload = JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded'
      })

      const rejected = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done after replacement',
        type: 'worker_done',
        payload
      })) as { lifecycle: { action: string; code: string } }

      expect(rejected.lifecycle).toEqual({
        action: 'rejected',
        code: 'sender_not_assignee',
        reason: `Dispatch ${dispatch.id} process incarnation is no longer current for its pane.`
      })
      expect(db.getTask(task.id)?.status).toBe('dispatched')

      vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:1')
      const accepted = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done by assignee',
        type: 'worker_done',
        payload
      })) as { lifecycle: { action: string } }
      expect(accepted.lifecycle.action).toBe('completed')
    })

    it.each(['escalation', 'decision_gate'] as const)(
      'fences a replacement process from a %s mutation',
      async (type) => {
        setup()
        const task = db.createTask({ spec: `process-bound ${type}` })
        const dispatch = createRootDispatch(
          db,
          task.id,
          'term_worker',
          'tab_worker:leaf_worker',
          undefined,
          'runtime_test:term_worker:1'
        )
        vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
          handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
        )
        vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue(
          'runtime_test:term_worker:2'
        )

        const rejected = (await call('orchestration.send', {
          from: 'term_worker',
          subject: `${type} after replacement`,
          type,
          payload: JSON.stringify({
            taskId: task.id,
            ...(type === 'decision_gate' ? { question: 'Proceed?' } : {})
          })
        })) as {
          lifecycle: { action: string; code: string }
          message: { type: string }
        }

        expect(rejected.lifecycle).toMatchObject({
          action: 'rejected',
          code: 'sender_not_assignee'
        })
        expect(db.getTask(task.id)?.status).toBe('dispatched')
        expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
        expect(db.listGates({ taskId: task.id })).toHaveLength(0)
        expect(rejected.message.type).toBe('status')

        vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue(
          'runtime_test:term_worker:1'
        )
        const accepted = (await call('orchestration.send', {
          from: 'term_worker',
          subject: `${type} by assignee`,
          type,
          payload: JSON.stringify({
            taskId: task.id,
            ...(type === 'decision_gate' ? { question: 'Proceed?' } : {})
          })
        })) as { message: { type: string } }
        expect(accepted.message.type).toBe(type)
      }
    )

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

    it('requires the minted capability, exact pane, and process incarnation', async () => {
      setup()
      const task = db.createTask({ spec: 'capability work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
      const capability = db.mintDispatchCapability({
        dispatchId: dispatch.id,
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )
      const payload = JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded'
      })

      const rejected = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload
      })) as { lifecycle: { code: string }; message: { subject: string } }
      expect(rejected).toMatchObject({
        lifecycle: { code: 'dispatch_capability_invalid' },
        message: { subject: 'Rejected worker_done: Done' }
      })
      expect(db.getTask(task.id)?.status).toBe('dispatched')

      ctx = { runtime, orchestrationCapability: 'dcap_wrong' }
      const wrongToken = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload
      })) as { lifecycle: { code: string } }
      expect(wrongToken.lifecycle.code).toBe('dispatch_capability_invalid')

      ctx = { runtime, orchestrationCapability: capability }
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_foreign:leaf_foreign' : coordinatorPaneKey
      )
      const wrongPane = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload
      })) as { lifecycle: { code: string } }
      expect(wrongPane.lifecycle.code).toBe('dispatch_capability_invalid')

      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )
      vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:2')
      const wrongProcess = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload
      })) as { lifecycle: { code: string } }
      expect(wrongProcess.lifecycle.code).toBe('dispatch_capability_invalid')

      vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:1')
      await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload
      })
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.capability_revoked_at).toBeTruthy()

      const revoked = (await call('orchestration.send', {
        from: 'term_worker',
        subject: 'Done again',
        type: 'worker_done',
        payload
      })) as { lifecycle: { code: string } }
      expect(revoked.lifecycle.code).toBe('dispatch_capability_invalid')
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

    it('still wakes waiters for a heartbeat on an active dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId: dispatch.id })
      })

      expect(notify).toHaveBeenCalledWith(`run:${activeRunId}`, 'heartbeat')
    })

    it('allows an omitted recipient so an active Dispatch can default to its Run', () => {
      const method = findMethod('orchestration.send')
      expect(method.params!.parse({ subject: 'hi' })).toMatchObject({ subject: 'hi' })
    })

    it('rejects missing --subject', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b' })).toThrow()
    })

    it('rejects invalid enum values', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', type: 'typo' })).toThrow()
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', priority: 'medium' })).toThrow()
    })

    it.each(['@all', '@idle', '@worktree:wt_1', '@codex', '@nobody'])(
      'rejects worker_done to group recipient %s without inserting rows',
      async (to) => {
        setup()
        const listTerminals = vi.spyOn(runtime, 'listTerminals')

        await expect(
          call('orchestration.send', {
            from: 'term_worker',
            to,
            subject: 'done',
            type: 'worker_done'
          })
        ).rejects.toThrow(lifecycleGroupRecipientError('worker_done'))

        expect(db.getInbox(100)).toHaveLength(0)
        expect(listTerminals).not.toHaveBeenCalled()
      }
    )

    it('rejects worker_done groups before terminal listing failures can win', async () => {
      setup()
      const listTerminals = vi
        .spyOn(runtime, 'listTerminals')
        .mockRejectedValue(new Error('terminal listing failed'))

      await expect(
        call('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'done',
          type: 'worker_done'
        })
      ).rejects.toThrow(lifecycleGroupRecipientError('worker_done'))

      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    it('returns invalid_argument for worker_done group sends through the dispatcher', async () => {
      setup()
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const listTerminals = vi.spyOn(runtime, 'listTerminals')

      const response = await dispatcher.dispatch(
        makeRequest('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'done',
          type: 'worker_done'
        })
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: lifecycleGroupRecipientError('worker_done')
        }
      })
      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    function makeSummary(
      handle: string,
      opts: Partial<RuntimeTerminalSummary> = {}
    ): RuntimeTerminalSummary {
      return {
        handle,
        ptyId: opts.ptyId ?? handle,
        worktreeId: opts.worktreeId ?? 'wt_default',
        worktreePath: opts.worktreePath ?? '/tmp/wt',
        branch: opts.branch ?? 'main',
        tabId: opts.tabId ?? 'tab_1',
        leafId: opts.leafId ?? handle,
        title: opts.title ?? null,
        connected: opts.connected ?? true,
        writable: opts.writable ?? true,
        lastOutputAt: opts.lastOutputAt ?? null,
        preview: opts.preview ?? ''
      }
    }

    function setupWithTerminals(
      terminals: RuntimeTerminalSummary[],
      agentStatuses?: Record<string, string>
    ): void {
      setup()
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
        terminals,
        totalCount: terminals.length,
        truncated: false
      })
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => {
        if (handle === 'term_coord') {
          return coordinatorPaneKey
        }
        const terminal = terminals.find((candidate) => candidate.handle === handle)
        return terminal ? `${terminal.tabId}:${terminal.leafId}` : null
      })
      vi.spyOn(runtime, 'getAgentStatusForHandle').mockImplementation(
        (handle: string) => agentStatuses?.[handle] ?? null
      )
    }

    it('fans out @all to all terminals except sender', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'broadcast'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(2)
      expect(result.messages).toHaveLength(2)
      const recipients = result.messages.map((m) => m.to_handle).sort()
      expect(recipients).toEqual(['term_b', 'term_c'])
    })

    it('continues to fan out status messages to groups', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'status broadcast',
        type: 'status'
      })) as { messages: { to_handle: string; type: string }[]; recipients: number }

      expect(result.recipients).toBe(2)
      expect(result.messages.map((m) => m.to_handle).sort()).toEqual(['term_b', 'term_c'])
      expect(result.messages.every((m) => m.type === 'status')).toBe(true)
    })

    it('rejects heartbeat group sends before inserting rows', async () => {
      setup()
      const listTerminals = vi.spyOn(runtime, 'listTerminals')

      await expect(
        call('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'alive',
          type: 'heartbeat',
          payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' })
        })
      ).rejects.toThrow(lifecycleGroupRecipientError('heartbeat'))

      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    it.each(['escalation', 'decision_gate'] as const)(
      'rejects %s group sends before inserting rows',
      async (type) => {
        setup()
        const listTerminals = vi.spyOn(runtime, 'listTerminals')

        await expect(
          call('orchestration.send', {
            from: 'term_worker',
            to: '@all',
            subject: `${type} broadcast`,
            type,
            payload: JSON.stringify({ taskId: 'task_1' })
          })
        ).rejects.toThrow(lifecycleGroupRecipientError(type))

        expect(listTerminals).not.toHaveBeenCalled()
        expect(db.getInbox(100)).toHaveLength(0)
      }
    )

    it('continues to send worker_done to a concrete terminal handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')

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
      })) as { message: { to_handle: string; type: string; payload: string | null } }

      expect(result.message.to_handle).toBe(`run:${activeRunId}`)
      expect(result.message.type).toBe('worker_done')
      expect(result.message.payload).toBe(
        JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      )
    })

    it('fans out @idle to only idle agents', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')], {
        term_b: 'idle',
        term_c: 'busy'
      })

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@idle',
        subject: 'idle check'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out agent name group (@claude) by title match', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Claude Code' }),
        makeSummary('term_b', { title: 'Claude Code' }),
        makeSummary('term_c', { title: 'Codex' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@claude',
        subject: 'claude only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @droid by title match', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Codex' }),
        makeSummary('term_b', { title: 'Droid ready' }),
        makeSummary('term_c', { title: 'Android build' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@droid',
        subject: 'droid only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @cursor by title match without claiming a cursor-mentioning title', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Codex' }),
        makeSummary('term_b', { title: 'Cursor ready' }),
        makeSummary('term_c', { title: '✳ Fix the text cursor blink' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@cursor',
        subject: 'cursor only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @worktree:<id> to matching worktree', async () => {
      setupWithTerminals([
        makeSummary('term_a', { worktreeId: 'wt_1' }),
        makeSummary('term_b', { worktreeId: 'wt_1' }),
        makeSummary('term_c', { worktreeId: 'wt_2' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@worktree:wt_1',
        subject: 'worktree msg'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('shares thread_id across fan-out messages', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'threaded',
        threadId: 'my_thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toBe('my_thread')
      expect(result.messages[1].thread_id).toBe('my_thread')
    })

    it('generates a shared thread_id when none provided', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'auto thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toMatch(/^thread_/)
      expect(result.messages[0].thread_id).toBe(result.messages[1].thread_id)
    })

    it('throws when group resolves to no recipients', async () => {
      setupWithTerminals([makeSummary('term_a')])

      await expect(
        call('orchestration.send', {
          from: 'term_a',
          to: '@all',
          subject: 'nobody home'
        })
      ).rejects.toThrow('No recipients resolved for group address')
    })

    it('releases dispatch lock before waking recipients when worker_done is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'lock-release work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')

      // Why: waiter notification must observe the settled Dispatch, not stale lifecycle state.
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
      // Lock released — a new dispatch to the same terminal must succeed.
      const t2 = db.createTask({ spec: 'follow-up work' })
      expect(() => createRootDispatch(db, t2.id, 'term_worker')).not.toThrow()
    })

    it('records heartbeat when heartbeat is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'heartbeat work' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBeTruthy()
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeDefined()
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
