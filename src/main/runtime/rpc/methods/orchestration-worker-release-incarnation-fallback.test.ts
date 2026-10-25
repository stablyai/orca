import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_METHODS } from './orchestration'
import { eraseRpcMethods, type RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { completeWorkerTerminalRelease } from './orchestration/worker/worker-release-completion'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'

const workerStartResult = z.object({ dispatchId: z.string(), state: z.string() })

describe('orchestration worker release incarnation fallback', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let inspectProcessLiveness: MockInstance<
    OrcaRuntimeService['inspectTerminalProcessIncarnationLiveness']
  >

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function workerTerminal(handle: string): RuntimeTerminalShow {
    return {
      handle,
      ptyId: 'pty_worker',
      paneRuntimeId: 1,
      rendererGraphEpoch: 1,
      worktreeId: 'repo::worktree',
      worktreePath: '/repo/worktree',
      branch: 'worktree',
      tabId: 'tab-worker',
      leafId: 'leaf-worker',
      title: 'worker',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    }
  }

  function workerAuthority(handle: string): OrchestrationCompatibilityTerminalAuthority {
    return {
      runtimeId: 'runtime_test',
      terminalHandle: handle,
      ptyId: 'pty_worker',
      worktreeId: 'repo::worktree',
      paneKey: workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    }
  }

  /** Fresh in-memory db and a fully-stubbed runtime for one worker-release scenario. */
  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    inspectProcessLiveness = vi
      .spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness')
      .mockResolvedValue('live')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker' || handle === 'term_reminted'
          ? workerPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted' ? workerAuthority(handle) : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => workerTerminal(handle))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker start reads only the managed worktree's id.
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
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  /** Look up a registered orchestration RPC method by name. */
  function findMethod(name: string) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  /** Parse a method's params and invoke its handler against the shared ctx. */
  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  /** Start a ready worker on a fresh task off the coordinator terminal. */
  async function startWorker(options: { terminal?: string } = {}): Promise<{
    taskId: string
    dispatchId: string
  }> {
    const task = db.createTask({ spec: 'release fixture task', runId: activeRunId })
    const result = workerStartResult.parse(
      await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
      })
    )
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  /** Record the worker's report as settled — the precondition for release. */
  function settle(taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed'): void {
    const settlement = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
    expect(settlement.action).toBe('settled')
  }

  /** Start a worker and settle its report, the state a release acts on. */
  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded',
    options: { terminal?: string } = {}
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker(options)
    settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  it('closes a live worker terminal whose durable handle no longer resolves but whose process incarnation still matches', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    // The durable handle stops resolving (renderer graph epoch bump / handle invalidation)...
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : workerTerminal(handle)
    )
    // ...but the recorded process incarnation still names a live PTY, re-minted to a fresh handle.
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )

    const receipt = await call('orchestration.workerRelease', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(resolveByIncarnation).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    // The close targeted exactly the re-minted live handle for that PTY, never the stale one.
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('stays release_unknown and closes nothing when the recorded incarnation no longer matches a live pty', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    // A reused ptyId now belongs to a different process: the incarnation mismatch refuses a close.
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )

    const receipt = await call('orchestration.workerRelease', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ state: 'release_unknown' })
    expect(resolveByIncarnation).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('does not plain-settle an exited missing worker when the archive was never committed', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = await call('orchestration.workerRelease', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ state: 'release_unknown', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalled()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'unknown'
    })
  })

  it('settles released without a close when exited missing and an archive is already committed', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const requested = db.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected requested, got ${requested.disposition}`)
    }
    db.commitWorkerTerminalArchiveForRelease({
      dispatchId,
      resourceId: requested.resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({ lines: [] }),
      archiveSource: 'terminal',
      archiveStatus: 'empty'
    })
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = await completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId,
      resource: db.getWorkerTerminalResource(requested.resource.id)!,
      mode: 'interactive'
    })

    expect(receipt).toMatchObject({ state: 'released', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('reaches settleDead before the lease check when a gone worker is exited with no live authority', async () => {
    // Without a committed archive settleDead retains; lease must not run first and force
    // retained/identity_unproven. Disposition is release_unknown (interactive) after the retain.
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = await call('orchestration.workerRelease', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ state: 'release_unknown', processAction: 'none' })
    expect(receipt).not.toMatchObject({ state: 'retained' })
    expect(inspectProcessLiveness).toHaveBeenCalled()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('concedes release_unknown before the lease check when a gone worker has no live authority and liveness is unproven', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    // Liveness is unresolvable/not-exited: the process may have been re-homed, so concede rather
    // than retain or guess at a live process.
    inspectProcessLiveness.mockResolvedValue('live')

    const receipt = await call('orchestration.workerRelease', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ state: 'release_unknown' })
    expect(receipt).not.toMatchObject({ state: 'retained' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('workerStop closes a live worker via the reminted handle when the durable handle is stale', async () => {
    setup()
    const { dispatchId } = await startWorker()
    // The durable handle stops resolving, but the recorded incarnation still names a live PTY.
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : workerTerminal(handle)
    )
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )

    const receipt = await call('orchestration.workerStop', { dispatch: dispatchId })

    expect(receipt).toMatchObject({ processAction: 'closed_agent_terminal' })
    // The kill targeted exactly the reminted live handle, never the stale durable one — closing
    // the stale handle would throw terminal_handle_stale and leak the PTY.
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
  })

  it('workerRead reads a live worker via the reminted handle when the durable handle is stale', async () => {
    setup()
    const { dispatchId } = await startWorker()
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : workerTerminal(handle)
    )
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )

    const output = await call('orchestration.workerRead', { dispatch: dispatchId })

    // Both the exact-session probe and the terminal read addressed the reminted handle.
    expect(runtime.getExactWorkerProviderSession).toHaveBeenCalledWith(
      'term_reminted',
      expect.any(Number)
    )
    expect(runtime.readTerminal).toHaveBeenCalledWith('term_reminted', expect.anything())
    expect(output).toMatchObject({
      terminal: { tail: ['worker output line 1', 'worker output line 2'] }
    })
  })

  it('recovery-mode: defers when exited missing has no archive rather than plain-settling', async () => {
    // Proof of death still runs settleDead first; when it retains (no archive), recovery must
    // stay release_pending — not plain-settle, not unknown.
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    inspectProcessLiveness.mockResolvedValue('exited')
    const requested = db.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected a requested release, got ${requested.disposition}`)
    }

    const receipt = await completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId,
      resource: requested.resource,
      mode: 'recovery'
    })

    expect(receipt).toMatchObject({ state: 'release_pending', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'requested'
    })
  })

  it('recovery-mode: settles released before the defer when exited missing already has an archive', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    inspectProcessLiveness.mockResolvedValue('exited')
    const requested = db.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected a requested release, got ${requested.disposition}`)
    }
    db.commitWorkerTerminalArchiveForRelease({
      dispatchId,
      resourceId: requested.resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({ lines: [] }),
      archiveSource: 'terminal',
      archiveStatus: 'empty'
    })

    const receipt = await completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId,
      resource: db.getWorkerTerminalResource(requested.resource.id)!,
      mode: 'recovery'
    })

    expect(receipt).toMatchObject({ state: 'released', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('recovery-mode: defers release_pending when liveness is unverifiable rather than provably exited', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      resolveByIncarnation
    )
    // Not a death certificate: inventory may still be incomplete, so recovery must defer.
    inspectProcessLiveness.mockResolvedValue('unverifiable')
    const requested = db.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected a requested release, got ${requested.disposition}`)
    }

    const receipt = await completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId,
      resource: requested.resource,
      mode: 'recovery'
    })

    expect(receipt).toMatchObject({ state: 'release_pending' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
  })
})
