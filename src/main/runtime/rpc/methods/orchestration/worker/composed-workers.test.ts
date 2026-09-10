import { mockCurrentWorkerStart } from './current-worker-start.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'

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

  async function call(name: string, params: Record<string, unknown>, context = ctx) {
    return h.call(
      name,
      name === 'orchestration.workerStart' ? { attemptId: 'attempt-test', ...params } : params,
      context
    )
  }

  describe('composed workers', () => {
    it('rejects a declared caller that disagrees with complete attested evidence', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
      const task = db.createTask({
        taskTitle: 'Implement worker start',
        displayName: 'Worker start engineer',
        spec: 'implement worker start'
      })
      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        dispatchId: string
        state: string
        effects: { kind: string; role?: string; action?: string; state?: string }[]
      }

      if (result.state !== 'ready') {
        throw new Error(JSON.stringify(result))
      }
      expect(result.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', action: 'reused' }),
          expect.objectContaining({ kind: 'terminal', role: 'agent', action: 'created' }),
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      )
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(result.dispatchId)?.state).toBe('ready')
      // Why: dispatching a worker adopts the tab without changing the visible workspace surface.
      expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
        startupAgent: 'codex',
        title: 'Worker start engineer',
        launchPreferences: {
          serviceTier: 'default',
          environmentPolicy: expect.stringMatching(/^sha256:/)
        },
        surfaceOwner: false,
        orchestrationManagedLaunch: true
      })
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining('--dispatch-capability dcap_'),
        expect.objectContaining({
          acceptQueued: true,
          observationTimeoutMs: 0,
          requestId: expect.any(String)
        })
      )
      expect(runtime.renameTerminal).not.toHaveBeenCalled()
    })

    it('applies and reports opaque per-invocation model preferences', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
          launchPreferences: {
            model: 'aws-bedrock-opus-5',
            effort: 'high',
            environmentPolicy: expect.stringMatching(/^sha256:/)
          },
          orchestrationManagedLaunch: true
        })
      )
      expect(JSON.parse(db.getWorkerDispatch(result.dispatchId)!.start_options)).toMatchObject({
        launch: result.launch
      })
    })

    it('rejects launch preferences for an existing terminal before creating a Dispatch', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
        dispatchId: string
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
        expect.objectContaining({
          startupAgent: 'codex',
          surfaceOwner: false,
          orchestrationManagedLaunch: true
        })
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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

    it('transfers a retry terminal only with the lease receipt transaction', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const task = db.createTask({ spec: 'retry exact terminal' })
      const predecessor = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskId: task.id,
        startOptions: {}
      })
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?")
        .run(predecessor.dispatch.id)
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?")
        .run(predecessor.dispatch.id)
      db.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id)
      const resource = db.createWorkerTerminalResourceStatement({
        dispatchId: predecessor.dispatch.id,
        worktreeId: 'repo::worktree',
        terminalHandle: 'term_worker',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1',
        ownership: 'owned'
      })
      const oldLease = db.reserveMaestroTerminalLease({
        requestId: 'worker:old',
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::worktree',
        runId: task.run_id,
        taskId: task.id,
        attemptId: 'attempt-test',
        role: 'worker',
        coordinatorGeneration: db.getRun(task.run_id)!.consumer_generation,
        workerTerminalResourceId: resource.id,
        title: 'old',
        launchProfile: {
          agent: null,
          model: null,
          effort: null,
          permissionMode: 'default',
          routeRef: null
        },
        spawnedBy: 'coordinator:g1',
        ownerPrincipal: `dispatch:${predecessor.dispatch.id}`,
        retentionPolicy: 'auto_release'
      })
      db.attachMaestroTerminalLease({
        leaseId: oldLease.id,
        terminalHandle: 'term_worker',
        tabId: 'tab_worker',
        paneKey: 'tab_worker:leaf_worker',
        ptyIncarnation: 'runtime_test:term_worker:1',
        processRootId: null
      })
      db.transitionMaestroTerminalLease({ leaseId: oldLease.id, state: 'ready' })
      db.transitionMaestroTerminalLease({ leaseId: oldLease.id, state: 'active' })

      const result = (await call(
        'orchestration.workerStart',
        {
          task: task.id,
          from: 'term_coord',
          terminal: 'term_worker',
          retryOf: predecessor.dispatch.id
        },
        {
          ...ctx,
          orchestrationMutation: {
            callerFingerprint: 'local-worker',
            requestId: 'retry-transfer',
            method: 'orchestration.workerStart',
            payloadHash: 'retry-transfer-payload'
          },
          recordMutationReceipt: () => {}
        }
      )) as { dispatchId: string; state: string; lastError?: string }

      if (result.state !== 'ready') {
        throw new Error(result.lastError)
      }
      expect(db.getMaestroTerminalLease(oldLease.id)?.lifecycleState).toBe('superseded')
      expect(db.getWorkerTerminalResource(resource.id)?.owner_dispatch_id).toBe(result.dispatchId)
      expect(
        db.db
          .prepare('SELECT count(*) AS count FROM maestro_terminal_lease_transfer_receipts')
          .get()
      ).toEqual({ count: 1 })
    })

    it('preserves the established external reuse transfer outside retries', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const oldTask = db.createTask({ spec: 'settled owner' })
      const oldDispatch = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskId: oldTask.id,
        startOptions: {}
      })
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?")
        .run(oldDispatch.dispatch.id)
      db.createWorkerTerminalResourceStatement({
        dispatchId: oldDispatch.dispatch.id,
        worktreeId: 'repo::worktree',
        terminalHandle: 'term_worker',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1',
        ownership: 'owned'
      })
      const task = db.createTask({ spec: 'unrelated reuse' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_worker'
      })) as { dispatchId: string; state: string }

      expect(result.state).toBe('ready')
      expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toBeDefined()
    })

    it('transfers a settled Maestro resource across tasks and reminted terminal handles', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const hostScope = JSON.stringify({ kind: 'local', hostId: 'local' })
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord'
          ? coordinatorPaneKey
          : handle === 'term_worker' || handle === 'term_reminted'
            ? 'tab_worker:leaf_worker'
            : null
      )
      vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
        handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
      )
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
        handle === 'term_worker' || handle === 'term_reminted'
          ? ({
              terminalHandle: handle,
              worktreeId: 'repo::worktree',
              paneKey: 'tab_worker:leaf_worker',
              processIncarnation: 'runtime_test:term_worker:1',
              hostScope: { kind: 'local', hostId: 'local' }
            } as never)
          : null
      )
      const predecessorTask = db.createTask({ spec: 'settled Maestro owner' })
      const predecessor = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskId: predecessorTask.id,
        startOptions: {}
      })
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?")
        .run(predecessor.dispatch.id)
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?")
        .run(predecessor.dispatch.id)
      db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(predecessorTask.id)
      const resource = db.createWorkerTerminalResourceStatement({
        dispatchId: predecessor.dispatch.id,
        worktreeId: 'repo::worktree',
        terminalHandle: 'term_worker',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime_test:term_worker:1',
        hostScope,
        ownership: 'owned'
      })
      const lease = db.reserveMaestroTerminalLease({
        requestId: 'worker:normal-old',
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::worktree',
        runId: predecessorTask.run_id,
        taskId: predecessorTask.id,
        attemptId: 'attempt-predecessor',
        coordinatorGeneration: db.getRun(predecessorTask.run_id)!.consumer_generation,
        role: 'worker',
        workerTerminalResourceId: resource.id,
        title: 'old',
        launchProfile: {
          agent: null,
          model: null,
          effort: null,
          permissionMode: 'default',
          routeRef: null
        },
        spawnedBy: 'coordinator:g1',
        ownerPrincipal: `dispatch:${predecessor.dispatch.id}`,
        retentionPolicy: 'auto_release'
      })
      db.attachMaestroTerminalLease({
        leaseId: lease.id,
        terminalHandle: 'term_worker',
        tabId: 'tab_worker',
        paneKey: 'tab_worker:leaf_worker',
        ptyIncarnation: 'runtime_test:term_worker:1',
        processRootId: null
      })
      db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
      db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'active' })
      const successorTask = db.createTask({ spec: 'successor uses reminted terminal' })

      const result = (await call('orchestration.workerStart', {
        task: successorTask.id,
        from: 'term_coord',
        terminal: 'term_reminted',
        attemptId: 'attempt-successor'
      })) as { dispatchId: string; state: string; leaseTransfer: Record<string, unknown> }

      expect(result.state).toBe('ready')
      expect(db.getMaestroTerminalLease(lease.id)?.lifecycleState).toBe('superseded')
      expect(db.getWorkerTerminalResource(resource.id)).toMatchObject({
        owner_dispatch_id: result.dispatchId,
        terminal_handle: 'term_reminted',
        host_scope: hostScope
      })
      expect(result.leaseTransfer).toMatchObject({
        kind: 'settled_resource_reuse',
        predecessor: {
          taskId: predecessorTask.id,
          attemptId: 'attempt-predecessor',
          terminalHandle: 'term_worker',
          hostScope
        },
        successor: {
          taskId: successorTask.id,
          attemptId: 'attempt-successor',
          terminalHandle: 'term_reminted',
          hostScope
        }
      })
      expect(
        db.db
          .prepare('SELECT count(*) AS count FROM maestro_terminal_lease_transfer_receipts')
          .get()
      ).toEqual({ count: 1 })
      expect(
        db.db
          .prepare(
            `SELECT count(*) AS count FROM maestro_terminal_leases
         WHERE worker_terminal_resource_id = ? AND lifecycle_state NOT IN ('released', 'superseded', 'archived')`
          )
          .get(resource.id)
      ).toEqual({ count: 1 })

      db.db
        .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?")
        .run(result.dispatchId)
      db.db
        .prepare("UPDATE dispatch_contexts SET status = 'failed' WHERE id = ?")
        .run(result.dispatchId)
      db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(successorTask.id)
      vi.mocked(runtime.sendTerminalAgentPrompt).mockResolvedValueOnce({
        handle: 'term_worker',
        accepted: false,
        bytesWritten: 0
      })
      const postTransferTask = db.createTask({ spec: 'post-transfer prompt failure' })
      const postTransfer = (await call('orchestration.workerStart', {
        task: postTransferTask.id,
        from: 'term_coord',
        terminal: 'term_worker',
        attemptId: 'attempt-post-transfer'
      })) as { dispatchId: string; state: string; leaseTransfer: Record<string, unknown> }

      expect(postTransfer).toMatchObject({
        state: 'outcome_unknown',
        leaseTransfer: { kind: 'settled_resource_reuse' }
      })
      expect(db.getWorkerTerminalResource(resource.id)?.owner_dispatch_id).toBe(
        postTransfer.dispatchId
      )
      expect(
        db.db
          .prepare(
            `SELECT count(*) AS count FROM maestro_terminal_leases
         WHERE worker_terminal_resource_id = ? AND lifecycle_state NOT IN ('released', 'superseded', 'archived')`
          )
          .get(resource.id)
      ).toEqual({ count: 1 })
    })

    it('returns an unverifiable receipt with exact recovery identity after readiness silence', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey, { ready: false })
      const task = db.createTask({ spec: 'worker timeout' })

      const result = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })) as {
        dispatchId: string
        state: string
        readiness: string
        attemptId: string
        leaseId: string
        terminalHandle: string
        failedStage: string
        residualResources: { id: string }[]
        nextCommands: string[]
      }

      expect(result).toMatchObject({
        state: 'outcome_unknown',
        readiness: 'unverifiable',
        attemptId: 'attempt-test',
        leaseId: expect.any(String),
        terminalHandle: 'term_worker',
        failedStage: 'agent_readiness'
      })
      expect(result.nextCommands).toEqual([
        expect.stringMatching(
          /^orca orchestration replace-worker --task .+ --predecessor .+ --json$/
        )
      ])
      expect(result.residualResources).toEqual([expect.objectContaining({ id: 'term_worker' })])
      expect(db.getTask(task.id)?.status).toBe('blocked')
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      vi.mocked(runtime.createTerminal).mockRejectedValueOnce(new Error('replacement spawn failed'))
      const replacement = (await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        replacementOf: result.dispatchId
      })) as { dispatchId: string; state: string }
      expect(replacement.state).toBe('failed')
      expect(db.getDispatchContextById(result.dispatchId)).toMatchObject({ status: 'failed' })
      expect(JSON.parse(db.getWorkerDispatch(replacement.dispatchId)!.start_options)).toMatchObject(
        {
          replacementOf: result.dispatchId,
          agent: 'codex'
        }
      )
    })

    it('returns a no-effect failure when terminal creation fails', async () => {
      setup()
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
      mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
        mockCurrentWorkerStart(runtime, coordinatorPaneKey)
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
  })
})
