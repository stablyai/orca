import { createHash } from 'node:crypto'
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

  function ownedResourceCount(dispatchId: string): number {
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { get: (...args: unknown[]) => { count: number } } }
      }
    ).db
    return raw
      .prepare(
        `SELECT COUNT(*) AS count
             FROM worker_terminal_resources
            WHERE owner_dispatch_id = ?`
      )
      .get(dispatchId).count
  }

  describe('composed workers', () => {
    function mockCurrentWorkerStart(options?: {
      ready?: boolean
      terminalWarning?: string
      terminalHandle?: string
      authorityLaunchTokenHash?: string
    }): void {
      // Why: the argv worker-start path pre-allocates the handle and mints the
      // launch token BEFORE createTerminal. Real createTerminal adopts both;
      // a mock that ignored them would trip the handle-substitution guard and
      // the launch-token bind guard, testing a runtime that cannot exist.
      let workerHandle = 'term_worker'
      let actualWorkerHandle = 'term_worker'
      let workerLaunchTokenHash: string | null = null
      vi.spyOn(runtime, 'createPreAllocatedTerminalHandle').mockReturnValue('term_worker')
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord'
          ? coordinatorPaneKey
          : handle === workerHandle
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
      vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_selector, opts) => {
        workerHandle = opts?.preAllocatedHandle ?? 'term_worker'
        actualWorkerHandle = options?.terminalHandle ?? workerHandle
        workerLaunchTokenHash = opts?.launchToken
          ? createHash('sha256').update(opts.launchToken).digest('hex')
          : null
        return {
          handle: actualWorkerHandle,
          worktreeId: 'repo::worktree',
          title: 'worker',
          ...(options?.terminalWarning
            ? { surface: 'background' as const, warning: options.terminalWarning }
            : {})
        } as never
      })
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
        handle === actualWorkerHandle && workerLaunchTokenHash
          ? ({
              runtimeId: runtime.getRuntimeId(),
              terminalHandle: actualWorkerHandle,
              ptyId: 'pty_worker',
              worktreeId: 'repo::worktree',
              paneKey: 'tab_worker:leaf_worker',
              processIncarnation: 'runtime_test:term_worker:1',
              launchTokenHash: options?.authorityLaunchTokenHash ?? workerLaunchTokenHash,
              hostScope: null
            } as never)
          : null
      )
      vi.spyOn(runtime, 'waitForTerminal').mockImplementation(
        async (handle) =>
          ({
            handle,
            condition: 'tui-idle',
            satisfied: options?.ready !== false,
            status: 'running',
            exitCode: null
          }) as never
      )
      vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
        handle === actualWorkerHandle ? 'runtime_test:term_worker:1' : null
      )
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
      vi.spyOn(runtime, 'getWorktreeOrchestrationCliCommand').mockResolvedValue('orca')
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 1
      })
    }

    it('rejects a declared caller that disagrees with complete attested evidence', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord' || handle === 'term_other'
          ? coordinatorPaneKey
          : handle === 'term_worker'
            ? 'tab_worker:leaf_worker'
            : null
      )
      const attestedEvidence = {
        terminalHandle: 'term_attested',
        paneKey: 'tab_attested:leaf_attested',
        launchToken: 'attested-launch-token'
      } as const
      vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
        terminalHandle: attestedEvidence.terminalHandle,
        paneKey: attestedEvidence.paneKey,
        processIncarnation: 'runtime_test:attested:1',
        launchTokenHash: 'attested-launch-token-hash',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      ctx = { ...ctx, orchestrationCompatibilityEvidence: attestedEvidence }
      const task = db.createTask({ spec: 'mismatched caller' })

      await expect(
        call('orchestration.workerStart', {
          task: task.id,
          from: 'term_other',
          agent: 'codex'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    })

    it('deliberately permits present but unverifiable restored-terminal evidence', async () => {
      setup()
      mockCurrentWorkerStart()
      // Restored/adopted terminals have no launch token, so verification returns null; this
      // fail-open is deliberate compatibility behavior, not an oversight.
      const task = db.createTask({ spec: 'restored caller limitation' })
      ctx = {
        ...ctx,
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term_worker',
          paneKey: 'tab_worker:leaf_worker'
        }
      }

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string }

      expect(result.state).toBe('ready')
      expect(db.getDispatchContext(task.id)).toBeDefined()
    })

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
      expect(
        result.effects.filter((effect) => effect.kind === 'terminal' && effect.role === 'agent')
      ).toHaveLength(1)
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(result.dispatchId)?.state).toBe('ready')
      expect(ownedResourceCount(result.dispatchId)).toBe(1)
      // Why: dispatching a worker is background work — surfaceOwner:false adopts
      // the tab without scrolling the sidebar to the worker's workspace.
      expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
        startupAgent: 'codex',
        preAllocatedHandle: expect.stringMatching(/^term_/),
        launchToken: expect.any(String),
        // Why: the preamble travels in the launch argv — the capability the
        // worker presents later must be the one baked in at spawn.
        agentPrompt: expect.stringContaining('--dispatch-capability dcap_'),
        title: `worker-${task.id}`,
        surfaceOwner: false
      })
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })

    it('persists the substituted argv terminal before rejecting its identity', async () => {
      setup()
      mockCurrentWorkerStart({ terminalHandle: 'term_adopted' })
      const task = db.createTask({ spec: 'reject substituted worker terminal' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        dispatchId: string
        state: string
        failedStage: string
        effects: { kind: string; role?: string; action?: string; id?: string }[]
        residualResources: { kind: string; role?: string; action?: string; id?: string }[]
      }

      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'authority_bind'
      })
      expect(result.effects).toContainEqual(
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: 'term_adopted'
        })
      )
      expect(result.residualResources).toContainEqual(
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: 'term_adopted'
        })
      )
      expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested',
        terminal_handle: 'term_adopted',
        pane_key: 'tab_worker:leaf_worker',
        process_incarnation: 'runtime_test:term_worker:1'
      })
      expect(ownedResourceCount(result.dispatchId)).toBe(1)
    })

    it('retains terminal ownership when authority binding fails after creation', async () => {
      setup()
      mockCurrentWorkerStart({ authorityLaunchTokenHash: 'wrong-launch-token-hash' })
      const task = db.createTask({ spec: 'retain worker after bind rejection' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        dispatchId: string
        state: string
        failedStage: string
        effects: { kind: string; role?: string; action?: string; id?: string }[]
        residualResources: { kind: string; role?: string; action?: string; id?: string }[]
      }

      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'authority_bind'
      })
      const terminalEffect = result.effects.find(
        (effect) => effect.kind === 'terminal' && effect.role === 'agent'
      )
      expect(terminalEffect?.id).toBeTruthy()
      expect(result.effects).toContainEqual(
        expect.objectContaining({ kind: 'terminal', role: 'agent', id: terminalEffect?.id })
      )
      expect(result.residualResources).toContainEqual(
        expect.objectContaining({ kind: 'terminal', role: 'agent', id: terminalEffect?.id })
      )
      expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toMatchObject({
        ownership_state: 'owned',
        terminal_handle: terminalEffect?.id,
        pane_key: 'tab_worker:leaf_worker',
        process_incarnation: 'runtime_test:term_worker:1'
      })
      expect(ownedResourceCount(result.dispatchId)).toBe(1)
    })

    it('embeds the WSL CLI name before the worker pane exists', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.getWorktreeOrchestrationCliCommand).mockResolvedValueOnce('orca-ide')
      const task = db.createTask({ spec: 'report from WSL' })

      await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })

      const createOptions = vi.mocked(runtime.createTerminal).mock.calls.at(-1)?.[1]
      expect(createOptions?.agentPrompt).toContain('orca-ide orchestration send')
      expect(runtime.getWorktreeOrchestrationCliCommand).toHaveBeenCalledWith('repo::worktree')
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
      const task = db.createTask({ spec: 'persist worker identity' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { dispatchId: string }

      // Why: the token handed to the spawn is the ONLY identity proof the
      // binding pane can present; the context must carry exactly its hash.
      const createOptions = vi.mocked(runtime.createTerminal).mock.calls.at(-1)?.[1]
      const launchToken = createOptions?.launchToken
      expect(launchToken).toBeTruthy()
      expect(db.getDispatchContextById(result.dispatchId)?.launch_token_hash).toBe(
        createHash('sha256').update(launchToken!).digest('hex')
      )
    })

    it('surfaces a worker terminal reveal failure without discarding the live worker', async () => {
      setup()
      mockCurrentWorkerStart({
        terminalWarning: 'Terminal term_worker is running but could not be revealed.'
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
      expect(result.effects).toContainEqual(
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      )
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

    // Why: agents without launch-embedded prompts still take the paste path,
    // where tui-idle readiness gates the brief; its timeout stays a failure.
    it('returns a failed receipt and preserves a created terminal as residual', async () => {
      setup()
      mockCurrentWorkerStart({ ready: false })
      const task = db.createTask({ spec: 'worker timeout' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'goose'
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
      })) as {
        dispatchId: string
        state: string
        failedStage: string
        effects: { kind: string }[]
        residualResources: unknown[]
      }

      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'terminal_create',
        residualResources: []
      })
      expect(result.effects).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'terminal' })])
      )
      expect(ownedResourceCount(result.dispatchId)).toBe(0)
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })

    // Why: prompt paste (and its rejection) only exists on the non-argv path.
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
        agent: 'goose'
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
      'reports a blocked startup screen without failing the ready dispatch for %s',
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
        const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
        const insertMessage = vi.spyOn(db, 'insertMessage')
        const task = db.createTask({ spec: 'blocked startup prompt' })

        const result = (await call('orchestration.workerStart', {
          task: task.id,
          from: 'term_coord',
          agent: 'codex'
        })) as { state: string; dispatchId: string }

        // Why: the brief is already delivered via argv and the capability is
        // bound — failing the start would revoke a capability the worker
        // presents after a human clears the screen. Ready stands; the blocked
        // screen surfaces as durable high-priority evidence to the Run.
        expect(result.state).toBe('ready')
        await vi.waitFor(() => {
          expect(insertMessage).toHaveBeenCalledWith(
            expect.objectContaining({
              priority: 'high',
              subject: expect.stringContaining(`startup blocked: ${blockedReason}`)
            })
          )
        })
        expect(notify).toHaveBeenCalled()
        expect(db.getWorkerDispatch(result.dispatchId)?.state).toBe('ready')
        expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      }
    )

    it('reports an argv readiness timeout with a fallback without revoking capability', async () => {
      setup()
      mockCurrentWorkerStart()
      vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'running',
        exitCode: null
      })
      const insertMessage = vi.spyOn(db, 'insertMessage')
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      const task = db.createTask({ spec: 'argv readiness timeout' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as { state: string; dispatchId: string }

      expect(result.state).toBe('ready')
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(result.dispatchId)).toMatchObject({
        status: 'dispatched',
        capability_revoked_at: null,
        capability_hash: expect.any(String)
      })
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'high',
          subject: expect.stringContaining(
            'startup blocked: Terminal readiness wait was not satisfied.'
          )
        })
      )
      const blockedMessage = insertMessage.mock.calls.at(-1)?.[0]
      expect(JSON.parse(blockedMessage?.payload ?? '{}')).toMatchObject({
        dispatchId: result.dispatchId,
        blockedReason: 'Terminal readiness wait was not satisfied.',
        terminalHandle: 'term_worker'
      })
      expect(notify).toHaveBeenCalled()
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    })

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
      const createdWorktree = {
        worktree: { id: 'repo::child', repoId: 'repo' },
        startupTerminal: { spawned: true, handle: 'term_worker' },
        setupReceipt: {
          requested: 'run',
          hookFound: true,
          startupPolicy: 'start-immediately',
          state: 'running',
          terminalHandle: 'term_setup'
        }
      } as never
      const create = vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
        const launchTokenHash = args.startupLaunchToken
          ? createHash('sha256').update(args.startupLaunchToken).digest('hex')
          : null
        vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(
          launchTokenHash
            ? ({
                runtimeId: runtime.getRuntimeId(),
                terminalHandle: 'term_worker',
                ptyId: 'pty_worker',
                worktreeId: 'repo::child',
                paneKey: 'tab_worker:leaf_worker',
                processIncarnation: 'runtime_test:term_worker:1',
                launchTokenHash,
                hostScope: null
              } as never)
            : null
        )
        return createdWorktree
      })
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
          expect.objectContaining({ role: 'agent', action: 'created' }),
          expect.objectContaining({ role: 'setup', action: 'created' }),
          expect.objectContaining({ role: 'configured_tab', action: 'created' })
        ])
      )
      expect(runtime.createTerminal).not.toHaveBeenCalled()
    })
  })
})
