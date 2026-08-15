import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: a federated worker terminal must go through the bounded launcher while
// preserving the resolved agent and launch preferences.
describe('federated worker agent launch', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('creates the remote worker terminal from the agent id, never as a command', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::remote-worktree'
    } as never)
    const legacyCreateTerminal = vi.spyOn(runtime, 'createTerminal')
    const createTerminal = vi
      .spyOn(runtime, 'createBoundedWorkerTerminal')
      .mockImplementation(async (_worktree, args) => {
        expect(db?.getRemoteDispatchAttachment(args.dispatchId)?.watchdog_sentinel_path).toBe(
          runtime.getWorkerWatchdogSentinelPath(args.dispatchId)
        )
        return {
          handle: 'term_remote_worker',
          worktreeId: 'repo::remote-worktree',
          title: 'worker',
          watchdogSentinelPath: '/tmp/ctx_remote-watchdog.json'
        }
      })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    // Why: without a stable pane the handler bails at agent_readiness, so the
    // assertions below would pass against a worker that never actually started.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1
    })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote codex worker',
        protocolVersion: 1,
        worktree: 'id:repo::remote-worktree',
        agent: 'codex',
        model: 'gpt-5.3-codex',
        effort: 'high',
        dispatchGroup: 'remote-agent-launch',
        dispatchIndex: 1,
        maxDispatches: 1,
        maxRuntimeMs: 60_000,
        maxRequests: 10,
        maxReviewCycles: 0,
        deadlineAt: new Date(Date.now() + 60_000).toISOString()
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as {
      state: string
      failedStage?: string
      lastError?: string
      launch: unknown
    }

    // Why: assert the worker actually reached ready — a spy-only assertion would
    // stay green even if every stage after terminal_create regressed.
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
        effective: { agent: 'codex', model: 'gpt-5.3-codex', effort: 'high' }
      }
    })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:repo::remote-worktree',
      expect.objectContaining({
        agent: 'codex',
        launchPreferences: { model: 'gpt-5.3-codex', effort: 'high' }
      })
    )
    expect(legacyCreateTerminal).not.toHaveBeenCalled()
  })

  it('rejects an elapsed immutable deadline before remote effects', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    const bounded = vi.spyOn(runtime, 'createBoundedWorkerTerminal')
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_elapsed',
          taskId: 'task_elapsed',
          taskSpec: 'must not start',
          protocolVersion: 2,
          worktree: 'id:repo::remote-worktree',
          agent: 'codex',
          dispatchGroup: 'remote-elapsed',
          dispatchIndex: 1,
          maxDispatches: 1,
          maxRuntimeMs: 60_000,
          maxRequests: 10,
          maxReviewCycles: 0,
          deadlineAt: '2020-01-01T00:00:00.000Z'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_elapsed',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'elapsed_payload'
          }
        }
      )
    ).rejects.toMatchObject({ code: 'runtime_budget_exhausted' })
    expect(db.getRemoteDispatchAttachment('ctx_elapsed')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_elapsed')).toBeUndefined()
    expect(bounded).not.toHaveBeenCalled()
  })
})
