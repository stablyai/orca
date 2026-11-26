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
      await releaseWorker(started.dispatchId)
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

  function nextWorkerHandle(): string {
    seq += 1
    return `term_worker_${seq}`
  }

  return { db, runtime, activeRunId, callStart, startFailedAttempt, releaseWorker, nextWorkerHandle }
}

describe('worker-start --retry-of launch preference rehydration', () => {
  let activeDb: ReturnType<typeof createRetryStartFixture>['db'] | null = null

  afterEach(() => {
    activeDb?.close()
    activeDb = null
    vi.restoreAllMocks()
  })

  it('rehydrates agent, model, and effort when --agent, --model, and --effort are omitted', async () => {
    const { db, runtime, callStart, startFailedAttempt, releaseWorker } = createRetryStartFixture()
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

    expect(
      db.settleWorkerReport({
        taskId: first.taskId,
        dispatchId: retried.dispatchId,
        outcome: 'failed',
        result: 'second attempt failed'
      }).action
    ).toBe('settled')
    await releaseWorker(retried.dispatchId)

    const sameAgentExplicit = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: retried.dispatchId,
      agent: 'codex'
    })
    expect(sameAgentExplicit).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
        effective: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' }
      }
    })
  })

  it('treats model and effort as one unit so an explicit --model does not inherit an incompatible prior effort', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
    // Claude opus accepts effort=high, whereas haiku accepts no effort levels at all.
    const first = await startFailedAttempt({
      agent: 'claude',
      model: 'opus',
      effort: 'high'
    })

    await expect(
      callStart({
        task: first.taskId,
        from: 'term_coord',
        retryOf: first.dispatchId,
        effort: 'medium'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--effort requires --model.'
    })

    const modelOverride = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId,
      model: 'haiku'
    })
    expect(modelOverride).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'claude', model: 'haiku', effort: null },
        effective: { agent: 'claude', model: 'haiku', effort: null }
      }
    })
    expect(modelOverride).not.toHaveProperty('warning')
    expect(vi.mocked(runtime.createTerminal).mock.calls[1]?.[1]).toMatchObject({
      startupAgent: 'claude',
      launchPreferences: { model: 'haiku' }
    })
  })

  it('does not carry over the prior model or effort on a cross-agent --agent override', async () => {
    const { db, runtime, callStart, startFailedAttempt } = createRetryStartFixture()
    activeDb = db
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

  it('drops inherited model and effort with a warning when retrying on an older peer without launch-preferences capability', async () => {
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
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const callPeer = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_envId, method, payload) => {
        if (method === 'status.get') {
          return {
            runtimeId: 'rt_older_peer',
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        const dispatchId =
          typeof payload === 'object' && payload !== null && 'dispatchId' in payload
            ? String(payload.dispatchId)
            : 'ctx_unknown'
        return {
          dispatchId,
          state: 'ready',
          runtimeEpoch: 'rt_older_peer',
          worktreeId: 'remote-worktree',
          terminalHandle: 'term_remote_worker'
        }
      })

    await expect(
      callStart(
        {
          task: first.taskId,
          from: 'term_coord',
          retryOf: first.dispatchId,
          on: 'older-peer',
          worktree: 'id:remote-worktree',
          model: 'gpt-5.2-codex'
        },
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'caller_coord',
            requestId: 'req_explicit_older_peer_retry',
            method: 'orchestration.workerStart',
            payloadHash: 'hash_explicit_older_peer_retry'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: 'Connected server older-peer does not support worker model or effort overrides.'
    })

    const retried = await callStart(
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

    expect(retried).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: null, effort: null },
        effective: { agent: 'codex', model: null, effort: null }
      },
      warning:
        'not carrying over model gpt-5.2-codex / effort high from the retried worker: Connected server older-peer does not support worker model or effort overrides.'
    })
    const attachCall = callPeer.mock.calls.find(
      ([, method]) => method === 'orchestration.federationAttachStart'
    )
    expect(attachCall?.[2]).toMatchObject({
      agent: 'codex',
      model: undefined,
      effort: undefined
    })
  })

  it('drops inherited opencode --model with a warning when retried on new-top-level or an unsupported host', async () => {
    const { db, runtime, callStart, startFailedAttempt, releaseWorker, nextWorkerHandle } =
      createRetryStartFixture()
    activeDb = db
    vi.spyOn(runtime, 'resolveOrchestrationAgentLauncher').mockImplementation((selector) =>
      selector === 'opencode' ? 'opencode' : undefined
    )
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    const probe = vi
      .spyOn(runtime, 'probeOrchestrationOpenCodeModelLaunchSupport')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setup resolution reads only repo hook metadata when present.
      { id: 'repo', path: '/tmp/repo' } as never
    )
    const createWorktree = vi
      .spyOn(runtime, 'createManagedWorktree')
      .mockImplementation(async (options) => {
        const handle = nextWorkerHandle()
        const terminal = { handle, worktreeId: 'repo::new-wt', title: 'worker' }
        options.onStartupTerminalCreated?.(terminal)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker worktree creation reads only worktree identity and startupTerminal.
        return {
          worktree: { id: 'repo::new-wt', repoId: 'repo', displayName: 'new-wt' },
          startupTerminal: terminal
        } as never
      })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({ terminals: [] })

    const first = await startFailedAttempt({
      agent: 'opencode',
      model: 'anthropic/claude-sonnet-4-5'
    })

    await expect(
      callStart({
        task: first.taskId,
        from: 'term_coord',
        retryOf: first.dispatchId,
        worktree: 'new-top-level',
        repo: 'repo',
        name: 'new-wt',
        model: 'anthropic/claude-sonnet-4-5'
      })
    ).rejects.toMatchObject({
      code: 'capability_unsupported',
      message:
        'OpenCode model selection requires an existing worktree. Use --worktree current or an existing worktree selector, or omit --model.'
    })

    const topLevelRetry = await callStart({
      task: first.taskId,
      from: 'term_coord',
      retryOf: first.dispatchId,
      worktree: 'new-top-level',
      repo: 'repo',
      name: 'new-wt'
    })
    expect(topLevelRetry).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'opencode', model: null, effort: null },
        effective: { agent: 'opencode', model: null, effort: null }
      },
      warning:
        'not carrying over model anthropic/claude-sonnet-4-5 from the retried worker: OpenCode model selection requires an existing worktree. Use --worktree current or an existing worktree selector, or omit --model.'
    })
    expect(createWorktree.mock.calls[0]?.[0]).not.toHaveProperty('startupLaunchPreferences')
    await releaseWorker(
      isStartReceipt(topLevelRetry) ? topLevelRetry.dispatchId : first.dispatchId
    )

    const second = await startFailedAttempt({
      agent: 'opencode',
      model: 'anthropic/claude-sonnet-4-5'
    })
    const hostFallbackRetry = await callStart({
      task: second.taskId,
      from: 'term_coord',
      retryOf: second.dispatchId
    })
    expect(hostFallbackRetry).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'opencode', model: null, effort: null },
        effective: { agent: 'opencode', model: null, effort: null }
      },
      warning:
        'not carrying over model anthropic/claude-sonnet-4-5 from the retried worker: OpenCode cannot apply a model choice on this execution host. Use a fresh local terminal in an existing workspace, or omit --model.'
    })
    expect(probe).toHaveBeenCalledTimes(3)
  })
})
