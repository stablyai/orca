import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWorkerStartReadinessTimeoutMs } from '../../../../../../shared/orchestration-timing-budgets'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const HANDLE = 'term_windows_worker'
const WORKTREE = 'repo::windows-worktree'

// Why: `worker-start --on <host>` launches the agent through this attach on the worker host, so
// it must wait for the same input box a local start waits for, or the task is typed too early.
describe('federated worker first dispatch readiness', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function createWorkerHost(): OrcaRuntimeService {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederationWorkerRuntime(runtime)
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockResolvedValue({
      handle: HANDLE,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    return runtime
  }

  async function attach(
    runtime: OrcaRuntimeService,
    target: { agent: string } | { terminal: string }
  ): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }
    const placement =
      'agent' in target
        ? { worktree: 'new-top-level', repo: 'windows-repo', name: 'remote-worker', ...target }
        : { worktree: WORKTREE, ...target }
    return await method.handler(
      method.params!.parse({
        runId: 'run-home',
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote worker',
        protocolVersion: 3,
        ...placement
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
    )
  }

  it.each(['opencode', 'opencode2', 'zcode'] as const)(
    'a %s terminal this attach created waits for its input box, not tui-idle',
    async (agent) => {
      const runtime = createWorkerHost()

      await expect(attach(runtime, { agent })).resolves.toMatchObject({ state: 'ready' })

      expect(runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith(
        HANDLE,
        agent,
        resolveWorkerStartReadinessTimeoutMs(undefined)
      )
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        HANDLE,
        expect.any(String),
        expect.any(Object)
      )
    }
  )

  it('a reused --terminal keeps the tui-idle wait', async () => {
    const runtime = createWorkerHost()
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reuse path reads only the worktree id.
      { id: WORKTREE } as never
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)

    await expect(attach(runtime, { terminal: HANDLE })).resolves.toMatchObject({ state: 'ready' })

    expect(runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(runtime.waitForTerminal).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ condition: 'tui-idle' })
    )
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      HANDLE,
      expect.any(String),
      expect.any(Object)
    )
  })

  it('fails at agent_readiness without typing the task when the input box never appears', async () => {
    const runtime = createWorkerHost()
    vi.mocked(runtime.waitForFreshWorkerComposer).mockRejectedValue(new Error('timeout'))

    await expect(attach(runtime, { agent: 'opencode' })).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      lastError: 'timeout'
    })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
