import { terminalExitError } from '../../../../../../shared/terminal-start-failure'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWorkerStartReadinessTimeoutMs } from '../../../../../../shared/orchestration-timing-budgets'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../../../agent-transcript-pane-test-harness'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const HANDLE = 'term_windows_worker'
const WORKTREE = 'repo::windows-worktree'

// Federated starts must wait for the same composer as local starts before typing the task.
describe('federated worker first dispatch readiness', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.useRealTimers()
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

  it.each(['pi', 'codex', 'claude', 'opencode'] as const)(
    'persists the %s execution-host failure without typing after recorded end',
    async (agent) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        launchAgent: agent,
        data: ''
      })
      const db = new OrchestrationDb(':memory:')
      databases.push(db)
      runtime.setOrchestrationDb(db)
      configureFederationWorkerRuntime(runtime, handle)
      vi.mocked(runtime.waitForTerminal).mockRestore()
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
      vi.useFakeTimers()
      const receipt = vi.fn()
      void attach(runtime, { agent }).then(receipt)
      await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce())
      expect(receipt.mock.calls[0][0]).toMatchObject({
        state: 'failed',
        failedStage: 'agent_readiness',
        lastError: 'terminal_exited'
      })
      expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
        state: 'failed',
        stage: 'agent_readiness',
        last_error: 'terminal_exited'
      })
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
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
  it.each(['fresh', 'reattach', 'adopted'] as const)(
    'uses actual %s creation for the failed readiness receipt',
    async (context) => {
      const runtime = createWorkerHost()
      const creation = {
        handle: HANDLE,
        ptyId: 'pty-created',
        incarnationId: 'inc-created',
        worktreeId: WORKTREE,
        title: null,
        ...(context === 'reattach' ? { isReattach: true as const } : {}),
        ...(context === 'adopted' ? { agentSessionDisposition: 'adopted' as const } : {})
      }
      const original = vi.mocked(runtime.createManagedWorktree).getMockImplementation()!
      vi.mocked(runtime.createManagedWorktree).mockImplementation(async (request) => {
        request.onStartupTerminalCreated?.(creation)
        return original(request)
      })
      vi.spyOn(runtime, 'getPtyLivenessVerdict').mockReturnValue({
        status: 'exited',
        incarnationId: 'inc-created',
        cause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      vi.mocked(runtime.waitForFreshWorkerComposer).mockRejectedValue(
        terminalExitError('timeout', {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        })
      )
      await expect(attach(runtime, { agent: 'opencode' })).resolves.toMatchObject({
        state: 'failed',
        failedStage: 'agent_readiness',
        lastError:
          context === 'fresh' ? expect.stringContaining('Close some Git Bash terminals') : 'timeout'
      })
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )
})
