import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

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
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
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
      // Why: dispatching a worker is background work — surfaceOwner:false adopts
      // the tab without scrolling the sidebar to the worker's workspace.
      expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
        startupAgent: 'codex',
        title: `worker-${task.id}`,
        surfaceOwner: false
      })
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining('--dispatch-capability dcap_')
      )
    })

    it('applies and reports opaque per-invocation model preferences', async () => {
      setup()
      mockCurrentWorkerStart()
      const task = db.createTask({ spec: 'launch a custom model' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high'
      })) as {
        dispatchId: string
        state: string
        launch: {
          requested: { agent: string; model: string; effort: string }
          effective: { agent: string; model: string; effort: string }
        }
      }

      expect(result).toMatchObject({
        state: 'ready',
        launch: {
          requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
          effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' }
        }
      })
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.objectContaining({
          startupAgent: 'claude',
          launchPreferences: { model: 'aws-bedrock-opus-5', effort: 'high' }
        })
      )
      expect(JSON.parse(db.getWorkerDispatch(result.dispatchId)!.start_options)).toMatchObject({
        launch: result.launch
      })
    })

    it('rejects launch preferences for an existing terminal before creating a Dispatch', async () => {
      setup()
      mockCurrentWorkerStart()
      const task = db.createTask({ spec: 'reuse exact worker' })

      await expect(
        call('orchestration.workerStart', {
          task: task.id,
          from: 'term_coord',
          terminal: 'term_worker',
          model: 'gpt-5.6-sol'
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    })

    // Why: `cursor` on PATH is the Cursor desktop app; passing the agent id as a
    // shell command opened the IDE and left a blank shell (issue #11926).
    it('never passes the agent id to the worker terminal as a shell command', async () => {
      setup()
      mockCurrentWorkerStart()
      const task = db.createTask({ spec: 'start a cursor worker' })

      await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'cursor'
      })

      expect(runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.objectContaining({ startupAgent: 'cursor' })
      )
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.not.objectContaining({ command: expect.anything() })
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

    it('starts in an exact existing worktree from a floating coordinator', async () => {
      setup()
      mockCurrentWorkerStart()
      const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
      vi.mocked(runtime.showTerminal).mockResolvedValue({
        handle: 'term_coord',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        status: 'running'
      } as never)
      vi.mocked(runtime.showManagedWorktree).mockImplementation(async (selector) => {
        if (selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`) {
          throw new Error('selector_not_found')
        }
        return { id: 'repo::other', repoId: 'repo' } as never
      })
      vi.mocked(runtime.showManagedTerminalWorkspace).mockResolvedValue({
        id: 'repo::other',
        repoId: 'repo'
      } as never)
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
        // Why: starting a worker in an existing worktree must not pull the sidebar
        // away from whatever the user is looking at.
        expect.objectContaining({ startupAgent: 'codex', surfaceOwner: false })
      )
      expect(createWorktree).not.toHaveBeenCalled()
      expect(runtime.showTerminal).toHaveBeenCalledWith('term_coord')
      expect(runtime.showManagedWorktree).not.toHaveBeenCalledWith(
        `id:${FLOATING_TERMINAL_WORKTREE_ID}`
      )
      expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledOnce()
      expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('id:repo::other')
    })

    it('starts in an exact existing folder workspace from a floating coordinator', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.showTerminal).mockResolvedValue({
        handle: 'term_coord',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        status: 'running'
      } as never)
      vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_not_found'))
      vi.mocked(runtime.showManagedTerminalWorkspace).mockResolvedValue({
        id: 'folder:workspace-1',
        repoId: 'folder-workspace:group-1'
      } as never)
      const task = db.createTask({ spec: 'folder workspace worker' })

      await expect(
        call('orchestration.workerStart', {
          task: task.id,
          from: 'term_coord',
          worktree: 'folder:workspace-1',
          agent: 'codex'
        })
      ).resolves.toMatchObject({ state: 'ready' })
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        'id:folder:workspace-1',
        expect.objectContaining({ startupAgent: 'codex', surfaceOwner: false })
      )
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
          runHooks: false,
          setupDecision: 'run',
          startupAgent: 'codex',
          activate: false,
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
})
