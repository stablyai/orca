/* eslint-disable max-lines -- Why: orchestration tests share a mock runtime factory; splitting by method would duplicate 40 lines of setup per file without improving clarity. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import { buildRegistry, type RpcContext, type RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../../shared/orchestration-ask-timeout'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

describe('orchestration RPC methods', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  function setup(withBoundRun = true): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
    )
    if (withBoundRun) {
      activeRunId = db.createRun({
        objective: 'Test Run',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey
      }).id
      // Why: default direct fixtures to current-contract state; legacy behavior has dedicated tests.
      const createTask = db.createTask.bind(db)
      db.createTask = (task) => createTask({ ...task, runId: task.runId ?? activeRunId })
      const insertMessage = db.insertMessage.bind(db)
      db.insertMessage = (message) =>
        insertMessage({ ...message, runId: message.runId ?? activeRunId })
    } else {
      activeRunId = undefined
    }
    ctx = { runtime }
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    const currentDb = db
    // Why: parser-only tests do not call setup(), so cleanup must not reuse
    // the previous test's already-closed in-memory DB.
    dbOpen = false
    currentDb.close()
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const scopedParams = { ...params }
    if (activeRunId) {
      if (name === 'orchestration.taskCreate' || name === 'orchestration.taskUpdate') {
        scopedParams.run ??= activeRunId
        scopedParams.callerTerminalHandle ??= 'term_coord'
      } else if (name === 'orchestration.taskList') {
        scopedParams.run ??= activeRunId
      } else if (name === 'orchestration.dispatch') {
        scopedParams.run ??= activeRunId
        scopedParams.from ??= 'term_coord'
      }
    }
    const parsed = method.params ? method.params.parse(scopedParams) : undefined
    return method.handler(parsed, ctx)
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

  it('registers all expected methods', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    expect(registry.size).toBe(34)
    expect(registry.has('orchestration.runCreate')).toBe(true)
    expect(registry.has('orchestration.runUse')).toBe(true)
    expect(registry.has('orchestration.runCurrent')).toBe(true)
    expect(registry.has('orchestration.runList')).toBe(true)
    expect(registry.has('orchestration.runShow')).toBe(true)
    expect(registry.has('orchestration.send')).toBe(true)
    expect(registry.has('orchestration.check')).toBe(true)
    expect(registry.has('orchestration.reply')).toBe(true)
    expect(registry.has('orchestration.inbox')).toBe(true)
    expect(registry.has('orchestration.taskCreate')).toBe(true)
    expect(registry.has('orchestration.taskList')).toBe(true)
    expect(registry.has('orchestration.taskUpdate')).toBe(true)
    expect(registry.has('orchestration.dispatch')).toBe(true)
    expect(registry.has('orchestration.dispatchShow')).toBe(true)
    expect(registry.has('orchestration.workerStart')).toBe(true)
    expect(registry.has('orchestration.workerShow')).toBe(true)
    expect(registry.has('orchestration.workerRead')).toBe(true)
    expect(registry.has('orchestration.workerStop')).toBe(true)
    expect(registry.has('orchestration.workerAbandon')).toBe(true)
    expect(registry.has('orchestration.federationAttachStart')).toBe(true)
    expect(registry.has('orchestration.federationPull')).toBe(true)
    expect(registry.has('orchestration.federationAck')).toBe(true)
    expect(registry.has('orchestration.federationImport')).toBe(true)
    expect(registry.has('orchestration.federationShow')).toBe(true)
    expect(registry.has('orchestration.federationRead')).toBe(true)
    expect(registry.has('orchestration.federationReadOutput')).toBe(true)
    expect(registry.has('orchestration.federationStop')).toBe(true)
    expect(registry.has('orchestration.ask')).toBe(true)
    expect(registry.has('orchestration.run')).toBe(true)
    expect(registry.has('orchestration.runStop')).toBe(true)
    expect(registry.has('orchestration.gateCreate')).toBe(true)
    expect(registry.has('orchestration.gateResolve')).toBe(true)
    expect(registry.has('orchestration.gateList')).toBe(true)
    expect(registry.has('orchestration.reset')).toBe(true)
  })

  describe('lightweight Runs', () => {
    it('creates and binds a Run to the runtime-resolved caller pane', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
        'tab_coord:11111111-1111-4111-8111-111111111111'
      )

      const created = (await call('orchestration.runCreate', {
        objective: 'Coordinate reviews',
        from: 'term_coord'
      })) as { run: { id: string; consumer_generation: number } }
      const current = (await call('orchestration.runCurrent', { from: 'term_coord' })) as {
        run: { id: string } | null
      }

      expect(created.run.consumer_generation).toBe(1)
      expect(current.run?.id).toBe(created.run.id)
    })

    it('requires runtime-observed stable pane identity for binding', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)

      await expect(
        call('orchestration.runCreate', { objective: 'No pane', from: 'term_stale' })
      ).rejects.toMatchObject({ code: 'stable_pane_required' })
      expect(db.listRuns().filter((run) => run.legacy === 0)).toHaveLength(0)
    })

    it('rebinds explicitly, lists Runs, and keeps the legacy Run inspect-only', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old'
          ? 'tab_old:11111111-1111-4111-8111-111111111111'
          : 'tab_new:22222222-2222-4222-9222-222222222222'
      )
      const created = (await call('orchestration.runCreate', {
        objective: 'Move me',
        from: 'term_old'
      })) as { run: { id: string } }
      const rebound = (await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_new'
      })) as { run: { consumer_generation: number } }
      const listed = (await call('orchestration.runList', {})) as {
        runs: { id: string; legacy: number }[]
      }

      expect(rebound.run.consumer_generation).toBe(2)
      expect(listed.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.run.id, legacy: 0 }),
          expect.objectContaining({ id: 'run_legacy_local', legacy: 1 })
        ])
      )
      await expect(
        call('orchestration.runUse', { id: 'run_legacy_local', from: 'term_new' })
      ).rejects.toMatchObject({ code: 'run_not_found' })
    })

    it('requires an explicit binding before task mutation', async () => {
      setup(false)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(coordinatorPaneKey)

      await expect(
        call('orchestration.taskCreate', {
          spec: 'must not become global',
          callerTerminalHandle: 'term_coord'
        })
      ).rejects.toMatchObject({
        code: 'run_required',
        data: {
          effectsApplied: false,
          nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
        }
      })
      expect(db.listTasks()).toHaveLength(0)
    })

    it('scopes task listing and fences the old coordinator after run-use', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      const runA = db.createRun({
        objective: 'A',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: oldPane
      })
      const runB = db.createRun({
        objective: 'B',
        coordinatorHandle: 'term_other',
        coordinatorPaneKey: newPane
      })
      const taskA = db.createTask({ spec: 'A work', runId: runA.id })
      db.createTask({ spec: 'B work', runId: runB.id })

      const listed = (await call('orchestration.taskList', { run: runA.id })) as {
        tasks: { id: string }[]
      }
      expect(listed.tasks.map((task) => task.id)).toEqual([taskA.id])

      db.bindRun({
        runId: runA.id,
        coordinatorHandle: 'term_new',
        coordinatorPaneKey: newPane
      })
      await expect(
        call('orchestration.taskCreate', {
          spec: 'stale write',
          run: runA.id,
          callerTerminalHandle: 'term_old'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
    })

    it('cancels and fences the old Run waiter when run-use rebinds', async () => {
      setup(false)
      const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
      const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_old' ? oldPane : newPane
      )
      const created = (await call('orchestration.runCreate', {
        objective: 'Wait fencing',
        from: 'term_old'
      })) as { run: { id: string } }
      const oldWait = call('orchestration.check', {
        terminal: 'term_old',
        wait: true,
        timeoutMs: 5_000
      })
      const fenced = expect(oldWait).rejects.toMatchObject({ code: 'consumer_fenced' })
      await Promise.resolve()

      await call('orchestration.runUse', {
        id: created.run.id,
        from: 'term_new'
      })

      await fenced
    })
  })

  describe('orchestration.send', () => {
    it('sends a message', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'hello'
      })) as { message: { id: string; from_handle: string; run_id: string } }

      expect(result.message.id).toMatch(/^msg_/)
      expect(result.message.from_handle).toBe('term_coord')
      expect(result.message.run_id).toBe(activeRunId)
      expect(runtime.deliverPendingMessagesForHandle).not.toHaveBeenCalled()
    })

    it('routes exact Dispatch mail independently of terminal handles', async () => {
      setup()
      const task = db.createTask({ spec: 'controlled worker' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')

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
      const dispatch = db.createDispatchContext(
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
      )
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
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
    })

    it('rejects an identity-less lifecycle send resolved through the coordinator handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dependent = db.createTask({ spec: 'dependent', deps: [task.id] })
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
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
      expect(result.lifecycle).toBeUndefined()
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
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

    it('continues to send worker_done to a concrete terminal handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')

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
      const dispatch = db.createDispatchContext(task.id, 'term_worker')

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
      expect(() => db.createDispatchContext(t2.id, 'term_worker')).not.toThrow()
    })

    it('records heartbeat when heartbeat is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'heartbeat work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
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
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
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
        type: 'escalation',
        run: activeRunId
      })

      const result = await waitPromise
      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('escalation')
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

  describe('orchestration.reply', () => {
    it('replies to a message', async () => {
      setup()
      const original = db.insertMessage({
        from: 'a',
        to: 'b',
        subject: 'question',
        runId: activeRunId
      })

      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'answer',
        from: 'b'
      })) as {
        message: { to_handle: string; subject: string; thread_id: string; run_id: string }
      }

      expect(result.message.to_handle).toBe('a')
      expect(result.message.subject).toBe('Re: question')
      expect(result.message.thread_id).toBe(original.id)
      expect(result.message.run_id).toBe(activeRunId)
    })

    it('throws on nonexistent message', async () => {
      setup()
      await expect(call('orchestration.reply', { id: 'msg_fake', body: 'nope' })).rejects.toThrow(
        'Message not found'
      )
    })

    it('records one idempotent answer from the current Run consumer', async () => {
      setup()
      const task = db.createTask({ spec: 'question work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      const created = db.createQuestion({
        runId: activeRunId!,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Proceed?'
      })
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const first = (await call('orchestration.reply', {
        id: created.message.id,
        body: 'Yes',
        from: 'term_coord'
      })) as { message: { id: string; to_handle: string }; duplicate: boolean }
      const repeated = (await call('orchestration.reply', {
        id: created.message.id,
        body: 'Yes',
        from: 'term_coord'
      })) as { message: { id: string }; duplicate: boolean }

      expect(first.message.to_handle).toBe(`dispatch:${dispatch.id}`)
      expect(first.duplicate).toBe(false)
      expect(repeated).toMatchObject({
        message: { id: first.message.id },
        duplicate: true
      })
      expect(notify).toHaveBeenCalledWith(`dispatch:${dispatch.id}`, 'status')
      expect(db.getQuestion(created.message.id)).toMatchObject({
        status: 'answered',
        answer_body: 'Yes'
      })
      await expect(
        call('orchestration.reply', {
          id: created.message.id,
          body: 'No',
          from: 'term_coord'
        })
      ).rejects.toMatchObject({ code: 'answer_conflict' })
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

  describe('orchestration.taskCreate', () => {
    it('creates a task', async () => {
      setup()
      const result = (await call('orchestration.taskCreate', {
        spec: 'implement feature X',
        taskTitle: 'Feature X',
        displayName: 'Implement feature X'
      })) as { task: { id: string; status: string } }

      expect(result.task.id).toMatch(/^task_/)
      expect(result.task.status).toBe('ready')
      expect(db.getTask(result.task.id)?.task_title).toBe('Feature X')
      expect(db.getTask(result.task.id)?.display_name).toBe('Implement feature X')
    })

    it('creates a task with deps', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })

      const result = (await call('orchestration.taskCreate', {
        spec: 'second',
        deps: JSON.stringify([t1.id])
      })) as { task: { status: string } }

      expect(result.task.status).toBe('pending')
    })

    it('records the caller terminal handle when creating a task', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_creator' ? coordinatorPaneKey : null
      )
      const result = (await call('orchestration.taskCreate', {
        spec: 'spawn related workspace',
        callerTerminalHandle: 'term_creator'
      })) as { task: { id: string } }

      expect(db.getTask(result.task.id)?.created_by_terminal_handle).toBe('term_creator')
    })

    it('rejects invalid deps JSON', async () => {
      setup()
      await expect(
        call('orchestration.taskCreate', { spec: 'bad', deps: 'not-json' })
      ).rejects.toThrow('Invalid --deps')
    })
  })

  describe('orchestration.taskList', () => {
    it('lists all tasks', async () => {
      setup()
      db.createTask({ spec: 'a' })
      db.createTask({ spec: 'b' })

      const result = (await call('orchestration.taskList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.updateTaskStatus(t2.id, 'completed')

      const result = (await call('orchestration.taskList', {
        status: 'ready'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.taskList')
      expect(() => method.params!.parse({ status: 'done-ish' })).toThrow()
    })

    it('includes assignee_handle and dispatch_id for dispatched tasks', async () => {
      setup()
      const t1 = db.createTask({ spec: 'ready work' })
      const t2 = db.createTask({ spec: 'active work' })
      const ctx = db.createDispatchContext(t2.id, 'term_worker')

      const result = (await call('orchestration.taskList', {})) as {
        tasks: {
          id: string
          status: string
          assignee_handle?: string | null
          dispatch_id?: string | null
        }[]
      }

      const ready = result.tasks.find((t) => t.id === t1.id)
      const dispatched = result.tasks.find((t) => t.id === t2.id)
      expect(ready).toBeDefined()
      expect(dispatched).toBeDefined()
      // Non-dispatched tasks keep the legacy shape — no assignee/dispatch fields.
      expect(ready).not.toHaveProperty('assignee_handle')
      expect(ready).not.toHaveProperty('dispatch_id')
      // Dispatched tasks surface the active dispatch.
      expect(dispatched?.assignee_handle).toBe('term_worker')
      expect(dispatched?.dispatch_id).toBe(ctx.id)
    })
  })

  describe('orchestration.taskList --brief', () => {
    it('abbreviates specs server-side so full text never crosses the wire', async () => {
      setup()
      db.createTask({ spec: `First line\n${'detail '.repeat(40)}` })
      db.createTask({ spec: 'Short task' })

      const result = (await call('orchestration.taskList', { brief: true })) as {
        tasks: { spec: string; spec_truncated: boolean }[]
      }

      const [long, short] = result.tasks
      expect(long.spec).toHaveLength(160)
      expect(long.spec_truncated).toBe(true)
      expect(short.spec).toBe('Short task')
      expect(short.spec_truncated).toBe(false)
    })
  })

  describe('orchestration.taskUpdate', () => {
    it('updates task status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed',
        result: '{"ok": true}'
      })) as { task: { status: string; result: string } }

      expect(result.task.status).toBe('completed')
      expect(result.task.result).toBe('{"ok": true}')
    })

    it('completion frees the active dispatch context', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed'
      })

      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('throws on nonexistent task', async () => {
      setup()
      await expect(
        call('orchestration.taskUpdate', { id: 'task_fake', status: 'completed' })
      ).rejects.toThrow('was not found')
    })
  })

  describe('orchestration.dispatch', () => {
    function provideInjectIdentity(handle = 'term_a'): void {
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((candidate) =>
        candidate === handle ? `tab_worker:${handle}` : coordinatorPaneKey
      )
    }

    it('dispatches a task to a terminal', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { task_id: string; status: string } }

      expect(result.dispatch.task_id).toBe(task.id)
      expect(result.dispatch.status).toBe('dispatched')
    })

    it('records the assignee pane key on the dispatch context', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_a' ? 'tab_w:leaf_w' : coordinatorPaneKey
      )
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { id: string } }

      expect(runtime.getTerminalPaneKey).toHaveBeenCalledWith('term_a')
      expect(db.getDispatchContextById(result.dispatch.id)?.assignee_pane_key).toBe('tab_w:leaf_w')
    })

    it('commits the target process launch token on a manual dispatch', async () => {
      setup()
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        runtimeId: runtime.getRuntimeId(),
        terminalHandle: 'term_a',
        ptyId: 'pty_a',
        worktreeId: 'repo::worktree',
        paneKey: 'tab_w:leaf_w',
        processIncarnation: 'runtime_test:term_a:1',
        launchTokenHash: 'launch-token-hash',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { id: string } }

      expect(db.getDispatchContextById(result.dispatch.id)?.launch_token_hash).toBe(
        'launch-token-hash'
      )
    })

    it('rejects dispatch for a pending task', async () => {
      setup()
      const parent = db.createTask({ spec: 'parent' })
      const child = db.createTask({ spec: 'child', deps: [parent.id] })

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_a'
        })
      ).rejects.toThrow('only ready tasks can be dispatched')
    })

    it('rolls back active dispatch when injection fails', async () => {
      setup()
      provideInjectIdentity()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(
        new Error('terminal_not_writable')
      )

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('terminal_not_writable')

      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('uses caller-provided dev mode for injected preamble', async () => {
      setup()
      provideInjectIdentity()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const send = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_a',
        accepted: true,
        bytesWritten: 1
      })

      await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        devMode: true
      })

      expect(send).toHaveBeenCalledWith(
        'term_a',
        expect.stringContaining('orca-dev orchestration send')
      )
    })

    it('uses the target pane CLI command for the returned preamble', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca-ide')

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_wsl',
        returnPreamble: true
      })) as { preamble: string }

      expect(runtime.getTerminalOrchestrationCliCommand).toHaveBeenCalledWith('term_wsl')
      expect(result.preamble).toContain('orca-ide orchestration send')
      expect(result.preamble).not.toMatch(/(^|\s)orca orchestration/m)
    })

    it('injects preamble through the agent prompt path instead of raw terminal send', async () => {
      setup()
      provideInjectIdentity()
      const task = db.createTask({ spec: 'line one\nline two' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const agentPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_a',
        accepted: true,
        bytesWritten: 1
      })
      const rawSend = vi.spyOn(runtime, 'sendTerminal')

      await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        from: 'term_coord'
      })

      expect(agentPrompt).toHaveBeenCalledWith(
        'term_a',
        expect.stringContaining('line one\nline two')
      )
      expect(rawSend).not.toHaveBeenCalled()
    })

    it('rejects inject to terminal without recognized agent', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('no recognized agent detected')
    })

    it('rejects dispatch to occupied terminal', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })
      const t2 = db.createTask({ spec: 'second' })
      db.createDispatchContext(t1.id, 'term_a')

      await expect(call('orchestration.dispatch', { task: t2.id, to: 'term_a' })).rejects.toThrow(
        /already has an active dispatch/
      )
    })

    it('dry-run returns the preamble without mutating state', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        dryRun: true,
        from: 'term_coord'
      })) as {
        dispatch: null
        dryRun: boolean
        preamble: string
        injected: boolean
      }

      expect(result.dryRun).toBe(true)
      expect(result.dispatch).toBeNull()
      expect(result.injected).toBe(false)
      expect(result.preamble).toContain('work')
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
      // Task state must not change on dry-run.
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    })

    it('returnPreamble includes preamble in the response', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        returnPreamble: true,
        from: 'term_coord'
      })) as { dispatch: { id: string }; preamble: string }

      expect(result.dispatch.id).toMatch(/^ctx_/)
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
    })
  })

  describe('composed workers', () => {
    function mockCurrentWorkerStart(options?: { ready?: boolean }): void {
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord'
          ? coordinatorPaneKey
          : handle === 'term_worker'
            ? 'tab_worker:leaf_worker'
            : null
      )
      vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
      vi.spyOn(runtime, 'showTerminal').mockImplementation(
        async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
      )
      vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
        id: 'repo::worktree'
      } as never)
      vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        title: 'worker'
      })
      vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: options?.ready !== false,
        status: 'running',
        exitCode: null
      })
      vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
        handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
      )
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 1
      })
    }

    it('starts a fresh agent in the coordinator current worktree', async () => {
      setup()
      mockCurrentWorkerStart()
      const task = db.createTask({ spec: 'implement worker start' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        dispatchId: string
        state: string
        effects: { kind: string; role?: string; action?: string; state?: string }[]
      }

      expect(result.state).toBe('ready')
      expect(result.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', action: 'reused' }),
          expect.objectContaining({ kind: 'terminal', role: 'agent', action: 'created' }),
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      )
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(result.dispatchId)?.state).toBe('ready')
      expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
        command: 'codex',
        title: `worker-${task.id}`
      })
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining('--dispatch-capability dcap_')
      )
    })

    it('commits the launched worker token with its durable authority', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        runtimeId: runtime.getRuntimeId(),
        terminalHandle: 'term_worker',
        ptyId: 'pty_worker',
        worktreeId: 'repo::worktree',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1',
        launchTokenHash: 'worker-launch-token-hash',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      const task = db.createTask({ spec: 'persist worker identity' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { dispatchId: string }

      expect(db.getDispatchContextById(result.dispatchId)?.launch_token_hash).toBe(
        'worker-launch-token-hash'
      )
    })

    it('surfaces a worker terminal reveal failure without discarding the live worker', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.createTerminal).mockResolvedValue({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        title: 'worker',
        surface: 'background',
        warning: 'Terminal term_worker is running but could not be revealed.'
      })
      const task = db.createTask({ spec: 'keep working if reveal fails' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        state: string
        warning?: string
        effects: { kind: string; surface?: string; warning?: string }[]
      }

      expect(result).toMatchObject({
        state: 'ready',
        warning: 'Terminal term_worker is running but could not be revealed.'
      })
      expect(result.effects).toContainEqual(
        expect.objectContaining({
          kind: 'terminal',
          surface: 'background',
          warning: 'Terminal term_worker is running but could not be revealed.'
        })
      )
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalled()
    })

    it('starts a fresh agent in an exact existing worktree without replaying setup', async () => {
      setup()
      mockCurrentWorkerStart()
      const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
      vi.mocked(runtime.showManagedWorktree).mockImplementation(
        async (selector) =>
          ({
            id: selector === 'id:repo::other' ? 'repo::other' : 'repo::worktree',
            repoId: 'repo'
          }) as never
      )
      const task = db.createTask({ spec: 'existing worktree worker' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        worktree: 'id:repo::other',
        agent: 'codex'
      })) as { state: string; setup: { state: string }; effects: unknown[] }

      expect(result).toMatchObject({ state: 'ready' })
      expect(result.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', action: 'reused', id: 'repo::other' }),
          expect.objectContaining({ kind: 'setup', action: 'not_applicable' })
        ])
      )
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::other',
        expect.objectContaining({ command: 'codex' })
      )
      expect(createWorktree).not.toHaveBeenCalled()
    })

    it('reuses only an explicitly selected existing agent terminal', async () => {
      setup()
      mockCurrentWorkerStart()
      const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const task = db.createTask({ spec: 'reuse exact worker' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_worker'
      })) as { state: string; effects: unknown[] }

      expect(result).toMatchObject({ state: 'ready' })
      expect(result.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'terminal',
            role: 'agent',
            action: 'reused',
            id: 'term_worker'
          })
        ])
      )
      expect(runtime.createTerminal).not.toHaveBeenCalled()
      expect(createWorktree).not.toHaveBeenCalled()
    })

    it('returns a failed receipt and preserves a created terminal as residual', async () => {
      setup()
      mockCurrentWorkerStart({ ready: false })
      const task = db.createTask({ spec: 'worker timeout' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string; failedStage: string; residualResources: { id: string }[] }

      expect(result).toMatchObject({ state: 'failed', failedStage: 'agent_readiness' })
      expect(result.residualResources).toEqual([expect.objectContaining({ id: 'term_worker' })])
      expect(db.getTask(task.id)?.status).toBe('failed')
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })

    it('returns a no-effect failure when terminal creation fails', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.createTerminal).mockRejectedValueOnce(new Error('terminal spawn rejected'))
      const task = db.createTask({ spec: 'terminal failure' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string; failedStage: string; residualResources: unknown[] }

      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'terminal_create',
        residualResources: []
      })
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })

    it('preserves the exact attached terminal when task input is rejected', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(
        new Error('agent input rejected')
      )
      const task = db.createTask({ spec: 'input failure' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        state: string
        failedStage: string
        residualResources: { kind: string; id: string }[]
      }

      expect(result).toMatchObject({ state: 'failed', failedStage: 'dispatch_input' })
      expect(result.residualResources).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'terminal', id: 'term_worker' })])
      )
    })

    it.each(['codex-update-prompt', 'codex-trust-workspace'] as const)(
      'returns a truthful readiness failure for %s',
      async (blockedReason) => {
        setup()
        mockCurrentWorkerStart()
        vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
          handle: 'term_worker',
          condition: 'tui-idle',
          satisfied: false,
          status: 'running',
          exitCode: null,
          blockedReason
        })
        const task = db.createTask({ spec: 'blocked startup prompt' })

        const result = (await call('orchestration.workerStart', {
          task: task.id,
          from: 'term_coord',
          agent: 'codex'
        })) as { state: string; failedStage: string; lastError: string }

        expect(result).toMatchObject({
          state: 'failed',
          failedStage: 'agent_readiness',
          lastError: `Agent startup blocked: ${blockedReason}`
        })
        expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      }
    )

    it('creates a child worktree agent-first with setup run by default', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.showManagedWorktree).mockResolvedValue({
        id: 'repo::parent',
        repoId: 'repo'
      } as never)
      vi.spyOn(runtime, 'showRepo').mockResolvedValue({
        id: 'repo',
        kind: 'git'
      } as never)
      const create = vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
        worktree: { id: 'repo::child', repoId: 'repo' },
        startupTerminal: { spawned: true, handle: 'term_worker' },
        setupReceipt: {
          requested: 'run',
          hookFound: true,
          startupPolicy: 'start-immediately',
          state: 'running',
          terminalHandle: 'term_setup'
        }
      } as never)
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
        terminals: [
          { handle: 'term_worker', title: 'Codex' },
          { handle: 'term_setup', title: 'Setup' },
          { handle: 'term_logs', title: 'Logs' }
        ],
        totalCount: 3,
        truncated: false
      } as never)
      const task = db.createTask({ spec: 'child worker' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'child-worker',
        agent: 'codex'
      })) as {
        state: string
        setup: { requested: string; startupPolicy: string; state: string }
        effects: { role?: string; action?: string }[]
      }

      expect(result).toMatchObject({
        state: 'ready',
        setup: {
          requested: 'run',
          startupPolicy: 'start-immediately',
          state: 'running'
        }
      })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          repoSelector: 'repo',
          name: 'child-worker',
          runHooks: true,
          setupDecision: 'run',
          startupAgent: 'codex',
          lineage: expect.objectContaining({ parentWorktree: 'repo::parent', noParent: false })
        })
      )
      expect(result.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'agent', action: 'reused_agent_terminal' }),
          expect.objectContaining({ role: 'setup', action: 'created' }),
          expect.objectContaining({ role: 'configured_tab', action: 'created' })
        ])
      )
      expect(runtime.createTerminal).not.toHaveBeenCalled()
    })
  })

  describe('orchestration.dispatchShow', () => {
    it('shows dispatch context for a task', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      const result = (await call('orchestration.dispatchShow', {
        task: task.id
      })) as { dispatch: { task_id: string } | null }

      expect(result.dispatch?.task_id).toBe(task.id)
    })

    it('returns null for unknown task', async () => {
      setup()
      const result = (await call('orchestration.dispatchShow', {
        task: 'task_fake'
      })) as { dispatch: null }

      expect(result.dispatch).toBeNull()
    })

    it('--preamble returns the preamble text', async () => {
      setup()
      const task = db.createTask({ spec: 'refactor auth' })
      db.createDispatchContext(task.id, 'term_a')

      const result = (await call('orchestration.dispatchShow', {
        task: task.id,
        preamble: true,
        from: 'term_coord'
      })) as { dispatch: { task_id: string } | null; preamble: string }

      expect(result.preamble).toContain('refactor auth')
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
      expect(result.dispatch?.task_id).toBe(task.id)
    })

    it('--preamble works when no dispatch exists yet', async () => {
      setup()
      const task = db.createTask({ spec: 'build feature' })

      const result = (await call('orchestration.dispatchShow', {
        task: task.id,
        preamble: true,
        from: 'term_coord'
      })) as { dispatch: null; preamble: string }

      expect(result.dispatch).toBeNull()
      expect(result.preamble).toContain('build feature')
    })

    it('--preamble throws for unknown task', async () => {
      setup()
      await expect(
        call('orchestration.dispatchShow', { task: 'task_fake', preamble: true })
      ).rejects.toThrow('Task not found')
    })
  })

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

  describe('orchestration.ask', () => {
    function createAskingDispatch(handle = 'term_worker') {
      const task = db.createTask({ spec: 'question work' })
      const dispatch = db.createDispatchContext(task.id, handle)
      return { task, dispatch }
    }

    it('persists a Run question and returns its first durable answer', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        const outbound = db.getInbox(10).find((message) => message.type === 'question')
        if (outbound) {
          db.answerQuestion({
            messageId: outbound.id,
            runId: activeRunId!,
            consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
            body: 'go ahead'
          })
        }
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'proceed?',
        options: 'yes, no',
        timeoutMs: 500
      })) as {
        answer: string
        messageId: string
        answerMessageId: string
        threadId: string
        timedOut: boolean
      }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('go ahead')
      expect(result.messageId).toMatch(/^msg_/)

      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      expect(outbound).toBeTruthy()
      expect(outbound?.to_handle).toBe(`run:${activeRunId}`)
      expect(outbound?.subject).toBe('Question')
      expect(outbound?.body).toBe('proceed?')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.question).toBe('proceed?')
      expect(payload.options).toEqual(['yes', 'no'])
      expect(db.getQuestion(outbound!.id)).toMatchObject({
        dispatch_id: dispatch.id,
        status: 'answered',
        answer_body: 'go ahead'
      })
      expect(db.getMessageById(result.answerMessageId)).toMatchObject({
        to_handle: `dispatch:${dispatch.id}`,
        read: 1
      })
      await expect(call('orchestration.check', { terminal: 'term_worker' })).resolves.toMatchObject(
        { count: 0, messages: [] }
      )
    })

    it('requires the Dispatch capability before creating a question', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      const capability = db.mintDispatchCapability({
        dispatchId: dispatch.id,
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : coordinatorPaneKey
      )

      await expect(
        call('orchestration.ask', {
          from: 'term_worker',
          question: 'unauthorized',
          timeoutMs: 1
        })
      ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
      expect(db.getInbox(100).filter((message) => message.type === 'question')).toHaveLength(0)

      ctx = { runtime, orchestrationCapability: capability }
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
      const accepted = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'authorized',
        timeoutMs: 1
      })) as { messageId: string; timedOut: boolean }
      expect(accepted.messageId).toMatch(/^msg_/)
      expect(accepted.timedOut).toBe(true)
    })

    it('returns timedOut when no reply arrives in the window', async () => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'still there?',
        timeoutMs: 1
      })) as { answer: string | null; timedOut: boolean; messageId: string | null }

      expect(result.timedOut).toBe(true)
      expect(result.answer).toBeNull()
      expect(result.messageId).toMatch(/^msg_/)
      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      expect(outbound).toBeTruthy()
      expect(db.getQuestion(outbound!.id)?.status).toBe('pending')
    })

    it('resumes the original question without creating a duplicate', async () => {
      setup()
      const { dispatch } = createAskingDispatch()
      const created = db.createQuestion({
        runId: activeRunId!,
        dispatchId: dispatch.id,
        askerHandle: 'term_worker',
        question: 'Resume me'
      })
      db.answerQuestion({
        messageId: created.message.id,
        runId: activeRunId!,
        consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
        body: 'recorded answer'
      })
      const messageCount = db.getInbox(100).length

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        resume: created.message.id,
        timeoutMs: 500
      })) as { answer: string; messageId: string; timedOut: boolean }

      expect(result).toMatchObject({
        answer: 'recorded answer',
        messageId: created.message.id,
        timedOut: false
      })
      expect(db.getInbox(100)).toHaveLength(messageCount)
    })

    it('returns promptly when the RPC signal aborts while waiting', async () => {
      setup()
      createAskingDispatch()
      vi.useFakeTimers()
      const controller = new AbortController()
      const method = findMethod('orchestration.ask')
      const parsed = method.params!.parse({
        from: 'term_worker',
        question: 'still there?',
        timeoutMs: 60_000
      })

      try {
        const promise = method.handler(parsed, {
          runtime,
          signal: controller.signal
        }) as Promise<{ timedOut: boolean; cancelled: boolean }>

        controller.abort()
        const outcomePromise = Promise.race([
          promise.then((result) => (result.cancelled ? 'cancelled' : 'answered')),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
        ])
        await vi.advanceTimersByTimeAsync(0)
        const outcome = await outcomePromise

        expect(outcome).toBe('cancelled')
      } finally {
        vi.useRealTimers()
      }
    })

    it('rejects group addresses with a dedicated error (no message persisted)', async () => {
      setup()
      await expect(
        call('orchestration.ask', {
          from: 'term_worker',
          to: '@reviewers',
          question: 'ok?'
        })
      ).rejects.toThrow(/does not support group addresses/)
      expect(db.getInbox(10)).toHaveLength(0)
    })

    it('ignores unrelated wakes until the durable question is answered', async () => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      let wakeCount = 0
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        wakeCount++
        const outbound = db.getInbox(20).find((message) => message.type === 'question')
        if (wakeCount === 1 && outbound) {
          db.insertMessage({
            from: 'unrelated',
            to: `dispatch:${db.getQuestion(outbound.id)!.dispatch_id}`,
            subject: 'unrelated',
            body: 'other',
            runId: activeRunId
          })
        } else if (wakeCount === 2 && outbound) {
          db.answerQuestion({
            messageId: outbound.id,
            runId: activeRunId!,
            consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
            body: 'correct answer'
          })
        }
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        question: 'filter?',
        timeoutMs: 2_000
      })) as { answer: string; timedOut: boolean }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('correct answer')
    })

    it.each<[number | undefined, number]>([
      [undefined, 600_000],
      [ORCHESTRATION_ASK_MAX_TIMEOUT_MS, ORCHESTRATION_ASK_MAX_TIMEOUT_MS],
      [Number.MAX_SAFE_INTEGER, ORCHESTRATION_ASK_MAX_TIMEOUT_MS]
    ])('applies effective timeout %s at the RPC handler boundary', async (requested, expected) => {
      setup()
      createAskingDispatch()
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      let observedTimeoutMs: number | undefined
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async (_handle, options) => {
        observedTimeoutMs = options?.timeoutMs
        // End the wait loop so the assertion runs against the first budget slice.
        const outbound = db.getInbox(10).find((message) => message.type === 'question')
        // Why: without a reply the handler's while(true) spins on this mock until vitest times out, hanging instead of failing.
        expect(outbound).toBeDefined()
        db.answerQuestion({
          messageId: outbound!.id,
          runId: activeRunId!,
          consumerGeneration: db.getRun(activeRunId!)!.consumer_generation,
          body: 'ok'
        })
        return 'notified'
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'bounded?',
        timeoutMs: requested
      })) as { timeoutMs: number }

      expect(observedTimeoutMs).toBeLessThanOrEqual(expected)
      expect(observedTimeoutMs).toBeGreaterThan(expected - 1_000)
      expect(result.timeoutMs).toBe(expected)
    })

    it('returns a zero effective timeout without entering the waiter', async () => {
      setup()
      createAskingDispatch()
      const waitForMessage = vi.spyOn(runtime, 'waitForMessage')

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'negative?',
        timeoutMs: -5
      })) as { timedOut: boolean; timeoutMs: number }

      expect(waitForMessage).not.toHaveBeenCalled()
      expect(result).toMatchObject({ timedOut: true, timeoutMs: 0 })
    })

    it('parses options CSV with whitespace and empty entries', async () => {
      setup()
      createAskingDispatch('w')
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

      await call('orchestration.ask', {
        from: 'w',
        question: 'q',
        options: 'a, b ,,c',
        timeoutMs: 1
      })

      const outbound = db.getInbox(10).find((message) => message.type === 'question')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.options).toEqual(['a', 'b', 'c'])
    })
  })

  describe('orchestration.reset', () => {
    function seedResetState(): void {
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })
    }

    it('resets all state', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: true })) as { reset: string }
      expect(result.reset).toBe('all')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets tasks only', async () => {
      setup()
      seedResetState()

      await call('orchestration.reset', { tasks: true })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets messages only', async () => {
      setup()
      seedResetState()

      await call('orchestration.reset', { messages: true })
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })

    it.each([
      ['empty params', {}],
      ['false-only params', { all: false }],
      ['multi-scope task and messages params', { tasks: true, messages: true }],
      ['multi-scope all and tasks params', { all: true, tasks: true }],
      ['non-boolean params', { all: 'true' }]
    ])('rejects %s without mutating state', async (_name, params) => {
      setup()
      seedResetState()

      await expect(call('orchestration.reset', params)).rejects.toThrow()
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)
    })

    it('ignores false scopes when exactly one scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: false, tasks: true })) as {
        reset: string
      }

      expect(result.reset).toBe('tasks')
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('ignores non-boolean scopes when exactly one real boolean scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: 'true', messages: true })) as {
        reset: string
      }

      expect(result.reset).toBe('messages')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })
  })
})
