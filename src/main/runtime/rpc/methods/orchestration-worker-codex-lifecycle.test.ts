import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('Codex worker task lifecycle release integration', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string
  let archiveThread: ReturnType<typeof vi.fn>
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: () => Promise<'live'>
      }
    ).inspectTerminalProcessIncarnationLiveness = vi.fn().mockResolvedValue('live')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ id: 'repo::worktree' } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output'],
      truncated: false,
      nextCursor: '1'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      closed: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'reconcileCodexWorkerThreadLifecycle').mockResolvedValue(undefined)
    archiveThread = vi
      .spyOn(runtime, 'archiveReleasedCodexWorkerThread')
      .mockResolvedValue(undefined)
    runId = db.createRun({
      objective: 'Codex release lifecycle test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  async function startWorker(terminal?: string): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'implement worker lifecycle', runId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(terminal ? { terminal } : { agent: 'codex' })
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  function settle(taskId: string, dispatchId: string): void {
    expect(
      db.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'done'
      }).action
    ).toBe('settled')
  }

  it('defers final release while exact Codex thread discovery is delayed', async () => {
    setup()
    const worker = await startWorker()
    settle(worker.taskId, worker.dispatchId)

    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      recovery: expect.stringContaining('Codex thread identity')
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(archiveThread).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'unknown'
    })

    const resource = db.getWorkerTerminalResourceByOwner(worker.dispatchId)!
    db.recordWorkerCodexThreadIdentity({
      dispatchId: worker.dispatchId,
      resourceId: resource.id,
      threadId: 'thread-delayed',
      autoName: 'Implement worker lifecycle'
    })
    db.markWorkerCodexThreadNameOutcome(resource.id, 'applied')
    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    expect(archiveThread).toHaveBeenCalledWith(worker.dispatchId, resource.id)
  })

  it('archives only the exact Codex thread after final owned-terminal release', async () => {
    setup()
    const worker = await startWorker()
    settle(worker.taskId, worker.dispatchId)
    const resource = db.getWorkerTerminalResourceByOwner(worker.dispatchId)!
    db.recordWorkerCodexThreadIdentity({
      dispatchId: worker.dispatchId,
      resourceId: resource.id,
      threadId: 'thread-worker',
      autoName: 'Implement worker lifecycle'
    })

    await expect(
      call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(archiveThread).toHaveBeenCalledWith(worker.dispatchId, resource.id)
    expect(archiveThread).not.toHaveBeenCalledWith(expect.anything(), 'thread-coordinator')
    expect(db.getWorkerTerminalResource(resource.id)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released',
      codex_archive_state: 'requested'
    })
  })

  it('worker_done settlement alone does not archive a reusable worker', async () => {
    setup()
    const worker = await startWorker()
    settle(worker.taskId, worker.dispatchId)

    expect(archiveThread).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
  })

  it('does not archive external, retained, or user-taken-over terminals', async () => {
    setup()
    const external = await startWorker('term_worker')
    settle(external.taskId, external.dispatchId)
    await expect(
      call('orchestration.workerRelease', { dispatch: external.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'external_terminal' })
    expect(archiveThread).not.toHaveBeenCalled()

    db.close()
    vi.restoreAllMocks()
    setup()
    const retained = await startWorker()
    settle(retained.taskId, retained.dispatchId)
    const retainedResource = db.getWorkerTerminalResourceByOwner(retained.dispatchId)!
    db.recordWorkerCodexThreadIdentity({
      dispatchId: retained.dispatchId,
      resourceId: retainedResource.id,
      threadId: 'thread-retained',
      autoName: 'Retained worker'
    })
    db.markWorkerCodexThreadNameOutcome(retainedResource.id, 'applied')
    const pendingRead = deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(runtime.readTerminal).mockReturnValue(pendingRead.promise)
    const release = call('orchestration.workerRelease', { dispatch: retained.dispatchId })
    await vi.waitFor(() => expect(runtime.readTerminal).toHaveBeenCalledTimes(1))
    await expect(
      call('orchestration.workerRetain', { dispatch: retained.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['retained output'],
      truncated: false,
      nextCursor: '1'
    })
    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(archiveThread).not.toHaveBeenCalled()

    db.close()
    vi.restoreAllMocks()
    setup()
    const takenOver = await startWorker()
    settle(takenOver.taskId, takenOver.dispatchId)
    await call('orchestration.workerTerminalUserInput', { paneKey: workerPaneKey })
    await expect(
      call('orchestration.workerRelease', { dispatch: takenOver.dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(archiveThread).not.toHaveBeenCalled()
  })
})
