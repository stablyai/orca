import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../../../core'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import {
  coordinatorPaneKey,
  createWorkerReleaseFixture,
  isStartReceipt,
  type WorkerReleaseFixture
} from '../release/worker-release.test-fixture'

function createRetryStartFixture() {
  const base: WorkerReleaseFixture = createWorkerReleaseFixture()
  const { db, runtime, activeRunId } = base
  let seq = 0

  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_target, options) => {
    seq += 1
    return {
      handle: `term_worker_${seq}`,
      worktreeId: 'repo::worktree',
      title: options?.title ?? 'worker'
    }
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
    if (handle === 'term_coord') {
      return coordinatorPaneKey
    }
    const match = /^term_worker_(\d+)$/.exec(handle)
    return match ? `tab_worker_${match[1]}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` : null
  })
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) => {
    const match = /^term_worker_(\d+)$/.exec(handle)
    return match ? `pty-worker-${match[1]}:11111111-1111-4111-8111-111111111111` : null
  })
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
    const paneKey = runtime.getTerminalPaneKey(handle)
    const processIncarnation = runtime.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation || handle === 'term_coord') {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker start reads only these authority fields.
    return {
      terminalHandle: handle,
      paneKey,
      processIncarnation,
      hostScope: { kind: 'local', hostId: 'local' }
    } as never
  })

  async function callStart(params: Record<string, unknown>, ctx: RpcContext = { runtime }) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method || isStreamingMethod(method)) {
      throw new Error('orchestration.workerStart not found')
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  async function startFailedAttempt(
    launch: { agent: string; model?: string; effort?: string },
    options: { releaseTerminal?: boolean } = {}
  ): Promise<{ taskId: string; dispatchId: string; terminalHandle: string }> {
    const task = db.createTask({ spec: 'retry launch defaults task', runId: activeRunId })
    const started = await callStart({
      task: task.id,
      from: 'term_coord',
      ...launch
    })
    if (!isStartReceipt(started)) {
      throw new Error('expected worker-start receipt')
    }
    expect(started.state).toBe('ready')
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatchId,
        outcome: 'failed',
        result: 'attempt failed'
      }).action
    ).toBe('settled')
    if (options.releaseTerminal !== false) {
      await expect(
        base.call('orchestration.workerRelease', { dispatch: started.dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
    }
    return {
      taskId: task.id,
      dispatchId: started.dispatchId,
      terminalHandle: `term_worker_${seq}`
    }
  }

  async function releaseWorker(dispatchId: string): Promise<void> {
    await expect(
      base.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
  }

  return { db, runtime, activeRunId, callStart, startFailedAttempt, releaseWorker }
}

describe('worker-start --retry-of launch preference rehydration', () => {
  let activeDb: ReturnType<typeof createRetryStartFixture>['db'] | null = null

  afterEach(() => {
    activeDb?.close()
    activeDb = null
    vi.restoreAllMocks()
  })

  it('rehydrates agent, model, and effort when --agent is omitted on --retry-of', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
    const first = await startFailedAttempt({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high'
    })

    const retried = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId
    })

    expect(retried).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' }
      }
    })
    expect(vi.mocked(runtime.createTerminal).mock.calls[1]?.[1]).toMatchObject({
      startupAgent: 'codex',
      launchPreferences: { model: 'gpt-5.2-codex', effort: 'high' }
    })
    if (!isStartReceipt(retried)) {
      throw new Error('expected retry receipt')
    }
    const persisted: unknown = JSON.parse(
      db.getWorkerDispatch(retried.dispatchId)?.start_options ?? '{}'
    )
    expect(persisted).toMatchObject({
      agent: 'codex',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' }
      }
    })
  })

  it('overrides only the specified --model or --effort flag while preserving the rest', async () => {
    const { db, callStart, startFailedAttempt, releaseWorker } = createRetryStartFixture()
    activeDb = db
    const first = await startFailedAttempt({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high'
    })

    const effortOverride = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId,
      effort: 'medium'
    })
    expect(effortOverride).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'medium' },
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'medium' }
      }
    })
    if (!isStartReceipt(effortOverride)) {
      throw new Error('expected effort override receipt')
    }
    expect(
      db.settleWorkerReport({
        taskId: first.taskId,
        dispatchId: effortOverride.dispatchId,
        outcome: 'failed',
        result: 'second attempt failed'
      }).action
    ).toBe('settled')
    await releaseWorker(effortOverride.dispatchId)

    const modelOverride = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: effortOverride.dispatchId,
      agent: 'codex',
      model: 'gpt-5.5'
    })
    expect(modelOverride).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' },
        effective: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' }
      }
    })
  })

  it('does not carry over the prior model or effort on a cross-agent --agent override', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
    // Codex accepts effort=minimal, whereas Claude rejects it; carrying it over would fail launch validation.
    const first = await startFailedAttempt({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'minimal'
    })

    const retried = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId,
      agent: 'claude'
    })

    expect(retried).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'claude', model: null, effort: null },
        effective: { agent: 'claude', model: null, effort: null }
      }
    })
    const secondTerminalOptions = vi.mocked(runtime.createTerminal).mock.calls[1]?.[1]
    expect(secondTerminalOptions).toMatchObject({ startupAgent: 'claude' })
    expect(secondTerminalOptions).not.toHaveProperty('launchPreferences')
  })

  it('preserves --terminal reuse guards and injects no agent or launch preferences when --terminal is passed', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
    const first = await startFailedAttempt(
      {
        agent: 'codex',
        model: 'gpt-5.2-codex',
        effort: 'high'
      },
      { releaseTerminal: false }
    )

    await expect(
      callStart({
        task: first.taskId,
        from: 'term_coord',
        retryOf: first.dispatchId,
        terminal: first.terminalHandle,
        agent: 'codex'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--terminal continues the agent already running there, in its current conversation. To start fresh, use --worktree or --agent without --terminal.'
    })

    await expect(
      callStart({
        task: first.taskId,
        from: 'term_coord',
        retryOf: first.dispatchId,
        terminal: first.terminalHandle,
        model: 'gpt-5.2-codex'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--model and --effort cannot be applied when reusing an existing terminal.'
    })

    const reused = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId,
      terminal: first.terminalHandle
    })
    expect(reused).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: null, model: null, effort: null }
      }
    })
    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('refuses paired-server retries when rehydrated model or effort targets an older peer without launch-preferences capability', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
    const first = await startFailedAttempt({
      agent: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'high'
    })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
      environmentId: 'env_older_peer',
      name: 'older-peer',
      peerFingerprint: 'peer_fp_older',
      pairingRevision: 1
    })
    const callPeer = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeId: 'rt_older_peer',
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
      ]
    })

    await expect(
      callStart(
        {
          task: first.taskId,
          from: 'term_coord',
          retryOf: first.dispatchId,
          on: 'older-peer',
          worktree: 'id:remote-worktree'
        },
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'caller_coord',
            requestId: 'req_older_peer_retry',
            method: 'orchestration.workerStart',
            payloadHash: 'hash_older_peer_retry'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: 'Connected server older-peer does not support worker model or effort overrides.'
    })

    expect(callPeer).toHaveBeenCalledTimes(1)
    expect(callPeer.mock.calls[0]?.[1]).toBe('status.get')
    expect(db.getDispatchContext(first.taskId)?.id).toBe(first.dispatchId)
  })

  it('runs OpenCode model launch probing when --retry-of rehydrates an opencode model', async () => {
    const { db, runtime, activeRunId, callStart, releaseWorker } = createRetryStartFixture()
    activeDb = db
    vi.spyOn(runtime, 'resolveOrchestrationAgentLauncher').mockImplementation((selector) =>
      selector === 'opencode' ? 'opencode' : undefined
    )
    const probe = vi
      .spyOn(runtime, 'probeOrchestrationOpenCodeModelLaunchSupport')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const task = db.createTask({ spec: 'opencode retry task', runId: activeRunId })
    const first = await callStart({
      task: task.id,
      from: 'term_coord',
      agent: 'opencode',
      model: 'anthropic/claude-sonnet-4-5'
    })
    if (!isStartReceipt(first)) {
      throw new Error('expected initial opencode start receipt')
    }
    expect(first.state).toBe('failed')
    await releaseWorker(first.dispatchId)

    await expect(
      callStart({
        task: task.id,
        from: 'term_coord',
        retryOf: first.dispatchId
      })
    ).rejects.toMatchObject({
      code: 'capability_unsupported',
      message:
        'OpenCode cannot apply a model choice on this execution host. Use a fresh local terminal in an existing workspace, or omit --model.'
    })

    expect(probe).toHaveBeenNthCalledWith(2, {
      worktree: 'id:repo::worktree',
      model: 'anthropic/claude-sonnet-4-5'
    })
  })
})
