import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildInjectRejectionMessage } from './orchestration-inject-rejection-message'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey, findMethod } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

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

    it('records the caller pane, process, and Run generation when creating a task', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_creator' ? coordinatorPaneKey : null
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
        terminalHandle: 'term_creator',
        paneKey: coordinatorPaneKey,
        processIncarnation: 'pty-creator:incarnation-a'
      } as never)
      const result = (await call('orchestration.taskCreate', {
        spec: 'spawn related workspace',
        callerTerminalHandle: 'term_creator'
      })) as { task: { id: string } }

      expect(db.getTask(result.task.id)).toMatchObject({
        created_by_terminal_handle: 'term_creator',
        created_by_pane_key: coordinatorPaneKey,
        created_by_process_incarnation: 'pty-creator:incarnation-a',
        created_by_run_generation: 1
      })
    })

    it('rejects non-JSON deps', async () => {
      setup()
      await expect(
        call('orchestration.taskCreate', { spec: 'bad', deps: 'not-json' })
      ).rejects.toThrow('Invalid --deps')
      await expect(
        call('orchestration.taskCreate', { spec: 'bad', deps: '[task_example]' })
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
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((candidate) =>
        candidate === handle
          ? ({
              terminalHandle: handle,
              paneKey: `tab_worker:${handle}`,
              processIncarnation: `runtime_test:${handle}:1`,
              launchTokenHash: null
            } as never)
          : null
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

    it('commits authenticated process authority on a manual dispatch', async () => {
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

      expect(db.getDispatchContextById(result.dispatch.id)).toMatchObject({
        assignee_pane_key: 'tab_w:leaf_w',
        process_incarnation: 'runtime_test:term_a:1',
        launch_token_hash: 'launch-token-hash'
      })
    })

    it('does not infer manual process authority from an unauthenticated handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { id: string } }

      expect(runtime.getTerminalProcessIncarnation('term_a')).toBe('runtime_test:term_a:1')
      expect(db.getDispatchContextById(result.dispatch.id)?.process_incarnation).toBeNull()
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
      ).rejects.toThrow(buildInjectRejectionMessage('term_a'))
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
})
