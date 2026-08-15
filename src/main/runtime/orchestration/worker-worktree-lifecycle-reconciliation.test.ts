import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PRRefreshOutcome } from '../../../shared/github/pull-request-refresh-types'
import type { Worktree } from '../../../shared/worktree/types'
import { OrcaRuntimeService } from '../orca-runtime'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { OrchestrationDb } from './db'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'
import { reconcileWorkerWorktreeLifecycles } from './worker-worktree-lifecycle-reconciliation'

describe('worker worktree lifecycle reconciliation', () => {
  const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const head = '1111111111111111111111111111111111111111'
  const worktreeId = 'repo::created'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let worktreeExists: boolean
  let pinned: boolean
  let prOutcome: PRRefreshOutcome
  let workerTerminalOpen: boolean
  let workerAgentStatus: 'working' | 'permission' | 'idle' | null
  let unrelatedTerminalOpen: boolean

  function createdWorktree(): Worktree {
    return {
      id: worktreeId,
      repoId: 'repo',
      displayName: 'lifecycle-worker',
      comment: '',
      linkedIssue: null,
      linkedPR: 17,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: pinned,
      sortOrder: 0,
      lastActivityAt: Date.now(),
      path: '/tmp/orca-lifecycle-worker',
      head,
      branch: 'refs/heads/test/lifecycle-worker',
      isBare: false,
      isMainWorktree: false
    }
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Lifecycle reconciliation test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: coordinatorPane
    }).id
    worktreeExists = true
    pinned = false
    prOutcome = mergedPR()
    workerTerminalOpen = true
    workerAgentStatus = 'idle'
    unrelatedTerminalOpen = false

    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPane : handle === 'term_worker' ? workerPane : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: workerPane,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) =>
        ({
          handle,
          worktreeId: handle === 'term_coord' ? 'repo::parent' : worktreeId,
          status: 'running'
        }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (selector) => {
      if (selector === 'id:repo::parent') {
        return { id: 'repo::parent', repoId: 'repo' } as never
      }
      if (selector === `id:${worktreeId}` && worktreeExists) {
        return createdWorktree() as never
      }
      throw new Error('selector_not_found')
    })
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => ({
      worktree: createdWorktree(),
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    }))
    vi.spyOn(runtime, 'listTerminals').mockImplementation(async () => {
      const terminals = [
        ...(workerTerminalOpen ? [{ handle: 'term_worker', title: 'Codex' }] : []),
        ...(unrelatedTerminalOpen ? [{ handle: 'term_unrelated', title: 'Shell' }] : [])
      ]
      return { terminals, totalCount: terminals.length, truncated: false } as never
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'waitForTerminalAgentInputReady').mockResolvedValue(true)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getTerminalAgentStatus').mockImplementation(async (handle) => {
      if (handle !== 'term_worker' || !workerTerminalOpen) {
        throw new Error('terminal_gone')
      }
      return { handle, isRunningAgent: true, status: workerAgentStatus }
    })
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['validated worker result'],
      truncated: false,
      nextCursor: '1'
    })
    vi.spyOn(runtime, 'closeTerminal').mockImplementation(async () => {
      workerTerminalOpen = false
      return { handle: 'term_worker', closed: true } as never
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'getRepoPRForBranch').mockImplementation(async () => prOutcome)
    vi.spyOn(runtime, 'removeManagedWorktree').mockImplementation(async () => {
      if (!worktreeExists) {
        throw new Error('selector_not_found')
      }
      worktreeExists = false
      return {}
    })
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function startWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'Implement and merge the lifecycle task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'new-child',
      name: 'lifecycle-worker',
      agent: 'codex'
    })
    const result = (await method.handler(params, { runtime })) as {
      dispatchId: string
      state: string
    }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  function settle(
    worker: { taskId: string; dispatchId: string },
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): void {
    expect(
      db.settleWorkerReport({
        taskId: worker.taskId,
        dispatchId: worker.dispatchId,
        outcome,
        result: `worker ${outcome}`
      }).action
    ).toBe('settled')
  }

  it('completes release and non-force worktree removal for a successful merged task', async () => {
    const worker = await startWorker()
    settle(worker)

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result).toMatchObject({ attempted: 1, removed: 1, retained: 0 })
    expect(db.getTask(worker.taskId)?.status).toBe('completed')
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${worktreeId}`,
      false,
      false,
      false,
      undefined,
      true,
      true,
      head,
      expect.any(Function)
    )
  })

  it('retains the worktree when worker_done succeeds but the PR remains open', async () => {
    prOutcome = openPR()
    const worker = await startWorker()
    settle(worker)

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'retained', reason: 'pr_not_merged' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('repairs a stale dispatched Task from exact merged-PR evidence before cleanup', async () => {
    const worker = await startWorker()

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'removed', taskReconciled: true })
    expect(db.getTask(worker.taskId)?.status).toBe('completed')
    expect(db.getDispatchContextById(worker.dispatchId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(worker.dispatchId)?.state).toBe('succeeded')
  })

  it('does not substitute merged-PR evidence while the assigned worker is still active', async () => {
    const worker = await startWorker()
    workerAgentStatus = 'working'

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({
      state: 'retained',
      reason: 'worker_still_active',
      taskReconciled: false
    })
    expect(db.getTask(worker.taskId)?.status).toBe('dispatched')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('surfaces dirty-worktree refusal and preserves the worktree', async () => {
    const worker = await startWorker()
    settle(worker)
    vi.mocked(runtime.removeManagedWorktree).mockRejectedValueOnce(
      new Error('Cannot delete worktree with uncommitted changes.')
    )

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'retained', reason: 'unsafe_to_remove' })
    expect(result.results[0]?.detail).toContain('uncommitted changes')
    expect(worktreeExists).toBe(true)
  })

  it('does not terminate an unrelated active terminal during automatic cleanup', async () => {
    const worker = await startWorker()
    settle(worker)
    unrelatedTerminalOpen = true
    vi.mocked(runtime.removeManagedWorktree).mockRejectedValueOnce(
      new Error(`Cannot automatically delete worktree ${worktreeId} while it has active terminals.`)
    )

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({
      state: 'retained',
      reason: 'active_terminal_reference'
    })
    expect(unrelatedTerminalOpen).toBe(true)
    expect(worktreeExists).toBe(true)
  })

  it('retains a completed worktree while another active Dispatch still references it', async () => {
    const worker = await startWorker()
    settle(worker)
    const dependentTask = db.createTask({ spec: 'Continue using the same worktree', runId })
    const dependent = db.createStartingWorkerDispatch({
      taskId: dependentTask.id,
      startOptions: { worktree: `id:${worktreeId}`, agent: 'codex' },
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dependent.dispatch.id,
      handle: 'term_dependent',
      paneKey: 'tab_dependent:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processIncarnation: 'runtime_test:term_dependent:1',
      worktreeId,
      effects: [{ kind: 'worktree', action: 'reused', id: worktreeId }],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })

    const result = await reconcileWorkerWorktreeLifecycles(runtime, {
      dispatchId: worker.dispatchId
    })

    expect(result.results[0]).toMatchObject({
      state: 'retained',
      reason: 'active_worktree_reference'
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('re-checks active Dispatch references inside the final removal boundary', async () => {
    const worker = await startWorker()
    settle(worker)
    vi.mocked(runtime.removeManagedWorktree).mockImplementationOnce(
      async (...args: Parameters<OrcaRuntimeService['removeManagedWorktree']>) => {
        const dependentTask = db.createTask({ spec: 'Late dependent work', runId })
        const dependent = db.createStartingWorkerDispatch({
          taskId: dependentTask.id,
          startOptions: { worktree: `id:${worktreeId}`, agent: 'codex' },
          runtimeEpoch: runtime.getRuntimeId()
        })
        db.prepareStartingWorkerAuthority({
          dispatchId: dependent.dispatch.id,
          handle: 'term_late_dependent',
          paneKey: 'tab_late:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          processIncarnation: 'runtime_test:term_late_dependent:1',
          worktreeId,
          effects: [{ kind: 'worktree', action: 'reused', id: worktreeId }],
          setupState: 'not_applicable',
          terminalOwnership: 'created'
        })
        await args[8]?.()
        throw new Error('automatic removal guard unexpectedly accepted the late reference')
      }
    )

    const result = await reconcileWorkerWorktreeLifecycles(runtime, {
      dispatchId: worker.dispatchId
    })

    expect(result.results[0]).toMatchObject({
      state: 'retained',
      reason: 'active_worktree_reference'
    })
    expect(worktreeExists).toBe(true)
  })

  it('honors an explicit worker retain as a durable cleanup escape hatch', async () => {
    const worker = await startWorker()
    settle(worker)
    expect(db.retainWorkerTerminalResource(worker.dispatchId).disposition).toBe('retained')

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'retained', reason: 'explicitly_retained' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('is idempotent when cleanup is run twice', async () => {
    const worker = await startWorker()
    settle(worker)

    const first = await reconcileWorkerWorktreeLifecycles(runtime)
    const second = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(first.removed).toBe(1)
    expect(second.alreadyRemoved).toBe(1)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledTimes(1)
  })

  it('recovers after restart when the PR merged before release and cleanup', async () => {
    const recoveryDir = await mkdtemp(join(tmpdir(), 'orca-lifecycle-restart-'))
    const recoveryDbPath = join(recoveryDir, 'orchestration.sqlite')
    try {
      db.close()
      db = new OrchestrationDb(recoveryDbPath)
      runtime.setOrchestrationDb(db)
      runId = db.createRun({
        objective: 'Persisted lifecycle restart test',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: coordinatorPane
      }).id
      const worker = await startWorker()
      settle(worker)

      db.close()
      db = new OrchestrationDb(recoveryDbPath)
      runtime.setOrchestrationDb(db)

      await reconcileRequestedWorkerTerminalReleases(runtime)

      expect(db.getTask(worker.taskId)?.status).toBe('completed')
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('released')
      expect(runtime.removeManagedWorktree).toHaveBeenCalledTimes(1)
      expect(worktreeExists).toBe(false)
    } finally {
      db.close()
      db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      await rm(recoveryDir, { recursive: true, force: true })
    }
  })

  it('re-runs the whole recovery pass when reconciliation is requested during PR lookup', async () => {
    const worker = await startWorker()
    settle(worker)
    const firstPR = deferred<PRRefreshOutcome>()
    vi.mocked(runtime.getRepoPRForBranch)
      .mockImplementationOnce(async () => firstPR.promise)
      .mockImplementation(async () => mergedPR())

    const first = reconcileRequestedWorkerTerminalReleases(runtime)
    await vi.waitFor(() => expect(runtime.getRepoPRForBranch).toHaveBeenCalledTimes(1))
    const second = reconcileRequestedWorkerTerminalReleases(runtime)
    expect(second).toBe(first)
    firstPR.resolve(openPR())

    await expect(first).resolves.toEqual(expect.objectContaining({ attempted: 0 }))
    expect(runtime.getRepoPRForBranch).toHaveBeenCalledTimes(2)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledTimes(1)
  })

  it('preserves failed or cancelled work without attempting terminal or worktree deletion', async () => {
    const worker = await startWorker()
    settle(worker, 'failed')

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'retained', reason: 'failed_or_cancelled' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('retains a worktree pinned after merge', async () => {
    const worker = await startWorker()
    settle(worker)
    pinned = true

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({ state: 'retained', reason: 'pinned' })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('reports a branch preserved by the existing safe Git cleanup mechanism', async () => {
    const worker = await startWorker()
    settle(worker)
    vi.mocked(runtime.removeManagedWorktree).mockResolvedValueOnce({
      preservedBranch: {
        branchName: 'test/lifecycle-worker',
        head,
        reason: 'branch_not_merged'
      }
    } as never)

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({
      state: 'removed',
      branch: { state: 'preserved', name: 'test/lifecycle-worker', head }
    })
  })

  it('does not accept a merged PR whose contents do not include the current HEAD', async () => {
    prOutcome = mergedPR({ headSha: '2222222222222222222222222222222222222222' })
    const worker = await startWorker()
    settle(worker)

    const result = await reconcileWorkerWorktreeLifecycles(runtime)

    expect(result.results[0]).toMatchObject({
      state: 'retained',
      reason: 'worktree_head_not_merged'
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  function mergedPR(overrides: { headSha?: string } = {}): PRRefreshOutcome {
    return {
      kind: 'found',
      fetchedAt: Date.now(),
      pr: {
        number: 17,
        title: 'Lifecycle fix',
        state: 'merged',
        url: 'https://github.com/stablyai/orca/pull/17',
        checksStatus: 'success',
        updatedAt: new Date().toISOString(),
        mergeable: 'MERGEABLE',
        headSha: overrides.headSha ?? head
      }
    }
  }

  function openPR(): PRRefreshOutcome {
    const outcome = mergedPR()
    if (outcome.kind !== 'found') {
      throw new Error('unexpected test fixture')
    }
    return { ...outcome, pr: { ...outcome.pr, state: 'open' } }
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((next) => {
      resolve = next
    })
    return { promise, resolve }
  }
})
