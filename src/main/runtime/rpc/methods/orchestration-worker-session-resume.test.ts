import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionRequest } from '../../../../shared/agent-session-host-authority'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration worker native session resume', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sourcePaneKey = 'tab_source:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const resumedPaneKey = 'tab_resumed:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const worktreeId = 'repo::worktree'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let ensureAgentSession: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Resume a closed worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_source'
          ? sourcePaneKey
          : handle === 'term_resumed'
            ? resumedPaneKey
            : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_source'
        ? 'runtime_test:source:1'
        : handle === 'term_resumed'
          ? 'runtime_test:resumed:1'
          : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
      const paneKey = runtime.getTerminalPaneKey(handle)
      const processIncarnation = runtime.getTerminalProcessIncarnation(handle)
      return paneKey && processIncarnation
        ? ({
            terminalHandle: handle,
            paneKey,
            processIncarnation,
            worktreeId,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    })
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId, status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({ id: worktreeId } as never)
    vi.spyOn(runtime, 'getOrchestrationWorkspaceHostScope').mockResolvedValue({
      kind: 'local',
      hostId: 'local'
    })
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_source',
      worktreeId,
      title: 'Codex'
    })
    ensureAgentSession = vi.spyOn(runtime, 'ensureAgentSession').mockResolvedValue({
      terminal: { handle: 'term_resumed', worktreeId, title: 'Codex' },
      disposition: 'created'
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_source',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_source',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue({
      paneKey: sourcePaneKey,
      processIncarnation: 'runtime_test:source:1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-session-secret' },
      observedAt: Date.now()
    })
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_source',
      status: 'running',
      tail: ['done'],
      truncated: false,
      nextCursor: '1'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_source',
      closed: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!found) {
      throw new Error(`Missing method ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const target = method(name)
    const parsed = target.params ? target.params.parse(params) : undefined
    return await target.handler(parsed, { runtime })
  }

  async function createReleasedSource(expectCheckpoint = true): Promise<string> {
    const task = db.createTask({ spec: 'Original worker task', runId })
    const started = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(started.state).toBe('ready')
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatchId,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'settled' })
    const release = await call('orchestration.workerRelease', { dispatch: started.dispatchId })
    expect(release).toMatchObject({
      resumeCheckpoint: expectCheckpoint ? 'captured' : 'unavailable'
    })
    if (expectCheckpoint) {
      expect(JSON.stringify(release)).not.toContain('provider-session-secret')
      expect(db.getWorkerResumeCheckpoint(started.dispatchId)).toMatchObject({
        source_dispatch_id: started.dispatchId,
        worktree_id: worktreeId,
        agent: 'codex',
        resumed_by_dispatch_id: null
      })
    }
    return started.dispatchId
  }

  async function resume(sourceDispatchId: string, spec = 'Follow-up task') {
    const task = db.createTask({ spec, runId })
    const result = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      resumeDispatch: sourceDispatchId
    })
    return { result: result as Record<string, unknown>, task }
  }

  it('resumes the exact provider session and replaces stale lifecycle instructions', async () => {
    const sourceDispatchId = await createReleasedSource()
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_resumed',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })

    const { result, task } = await resume(sourceDispatchId)

    expect(result).toMatchObject({ state: 'ready', taskId: task.id })
    expect(ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining<Partial<RuntimeEnsureAgentSessionRequest>>({
        kind: 'explicit',
        worktree: `id:${worktreeId}`,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-secret' },
        presentation: 'background'
      })
    )
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
    const prompt = vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls.at(-1)?.[1] ?? ''
    expect(prompt).toContain('NATIVE SESSION RESUME BOUNDARY')
    expect(prompt).toContain(sourceDispatchId)
    expect(prompt).toContain(task.id)
    expect(prompt).toContain(result.dispatchId as string)
    expect(prompt).not.toContain('provider-session-secret')
  })

  it('fails closed when a released legacy worker has no checkpoint', async () => {
    vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue(null)
    const sourceDispatchId = await createReleasedSource(false)

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_checkpoint_missing'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects a source worker that has not settled and released', async () => {
    const task = db.createTask({ spec: 'Still active', runId })
    const started = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string }

    await expect(resume(started.dispatchId)).rejects.toMatchObject({
      code: 'resume_source_active'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('does not fall back to a fresh terminal when the provider claim is unavailable', async () => {
    const sourceDispatchId = await createReleasedSource()
    ensureAgentSession.mockRejectedValue(new Error('agent_session_claim_unavailable'))

    const { result } = await resume(sourceDispatchId)

    expect(result).toMatchObject({ state: 'failed', failedStage: 'agent_resume' })
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
  })

  it('retains a resumed terminal as a residual resource when readiness fails', async () => {
    const sourceDispatchId = await createReleasedSource()
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_resumed',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })

    const { result } = await resume(sourceDispatchId)

    expect(result).toMatchObject({
      state: 'failed',
      residualResources: [
        expect.objectContaining({ kind: 'terminal', action: 'resumed', id: 'term_resumed' })
      ]
    })
  })

  it('fails closed when host authority reports the provider session already adopted', async () => {
    const sourceDispatchId = await createReleasedSource()
    ensureAgentSession.mockResolvedValue({
      terminal: { handle: 'term_resumed', worktreeId, title: 'Codex' },
      disposition: 'adopted'
    } as never)

    const { result } = await resume(sourceDispatchId)

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'agent_resume',
      lastError: expect.stringContaining('already owned')
    })
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
  })

  it('lets only one new Dispatch claim the old provider session', async () => {
    const sourceDispatchId = await createReleasedSource()
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_resumed',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })

    await expect(resume(sourceDispatchId, 'First follow-up')).resolves.toMatchObject({
      result: { state: 'ready' }
    })
    await expect(resume(sourceDispatchId, 'Conflicting follow-up')).rejects.toMatchObject({
      code: 'resume_checkpoint_claimed'
    })
    expect(ensureAgentSession).toHaveBeenCalledOnce()
  })

  it('replays the same durable request without resuming a second terminal', async () => {
    const sourceDispatchId = await createReleasedSource()
    const task = db.createTask({ spec: 'Retry-safe follow-up', runId })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request: RpcRequest = {
      id: 'rpc_resume_retry',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'resume_retry_request',
      method: 'orchestration.workerStart',
      params: { task: task.id, from: 'term_coord', resumeDispatch: sourceDispatchId }
    }

    const first = await dispatcher.dispatch(request)
    const replay = await dispatcher.dispatch({ ...request, id: 'rpc_resume_retry_replay' })
    if (!first.ok) {
      throw new Error(`Initial resume failed: ${first.error.message}`)
    }

    expect(first).toMatchObject({ ok: true, result: { state: 'ready' } })
    expect(replay).toMatchObject({
      ok: true,
      result: { dispatchId: (first.result as { dispatchId: string }).dispatchId }
    })
    expect(ensureAgentSession).toHaveBeenCalledOnce()
  })

  it('rejects an unsupported provider family before launch', async () => {
    const sourceDispatchId = await createReleasedSource()
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db
    raw
      .prepare('UPDATE worker_resume_checkpoints SET agent = ? WHERE source_dispatch_id = ?')
      .run('cursor', sourceDispatchId)

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_agent_unsupported'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects a provider family mismatch before launch', async () => {
    const sourceDispatchId = await createReleasedSource()
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db
    raw
      .prepare('UPDATE worker_resume_checkpoints SET agent = ? WHERE source_dispatch_id = ?')
      .run('claude', sourceDispatchId)

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_provider_mismatch'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects a checkpoint whose host ownership drifted', async () => {
    const sourceDispatchId = await createReleasedSource()
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db
    raw
      .prepare('UPDATE worker_resume_checkpoints SET host_scope = ? WHERE source_dispatch_id = ?')
      .run(JSON.stringify({ kind: 'local', hostId: 'other-host' }), sourceDispatchId)

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_checkpoint_mismatch'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects a checkpoint whose worktree ownership drifted', async () => {
    const sourceDispatchId = await createReleasedSource()
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }
      }
    ).db
    raw
      .prepare('UPDATE worker_resume_checkpoints SET worktree_id = ? WHERE source_dispatch_id = ?')
      .run('repo::other-worktree', sourceDispatchId)

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_checkpoint_mismatch'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects a worktree now routed to a different execution host', async () => {
    const sourceDispatchId = await createReleasedSource()
    vi.mocked(runtime.getOrchestrationWorkspaceHostScope).mockResolvedValue({
      kind: 'ssh',
      targetId: 'other-host'
    })

    await expect(resume(sourceDispatchId)).rejects.toMatchObject({
      code: 'resume_host_mismatch'
    })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })
})
