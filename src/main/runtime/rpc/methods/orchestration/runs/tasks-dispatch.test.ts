import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import '../../../../../../shared/orchestration/orchestration-dispatch-refusal-contract'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import '../../../../orchestration/workers/launch/worker-dispatch-preamble'

describe('orchestration RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
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

    it('rejects dispatch to occupied terminal', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })
      const t2 = db.createTask({ spec: 'second' })
      createRootDispatch(db, t1.id, 'term_a')

      await expect(call('orchestration.dispatch', { task: t2.id, to: 'term_a' })).rejects.toThrow(
        /already has an active dispatch/
      )
    })
  })
})
