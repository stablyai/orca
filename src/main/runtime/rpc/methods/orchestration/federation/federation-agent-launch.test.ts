import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

// Resolve agent ids through TUI config on remote hosts too; using cursor as a command launched its desktop app (#11926).
describe('federated worker agent launch', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('creates an exact folder worker terminal from the agent id, never as a command', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    // Supply a stable pane so the handler reaches agent_readiness rather than refusing before the assertions.
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
        runId: 'run-home',
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote cursor worker',
        depth: 2,
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'cursor',
        model: 'gpt-5.3-codex',
        effort: 'high'
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

    // Assert ready, not just the launch spy, so later-stage regressions fail.
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' },
        effective: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }
      }
    })
    expect(db.getRemoteDispatchAttachment('ctx_remote')?.depth).toBe(2)
    expect(createTerminal).toHaveBeenCalledWith(
      'id:folder:remote-workspace',
      expect.objectContaining({
        startupAgent: 'cursor',
        launchPreferences: { model: 'gpt-5.3-codex', effort: 'high' }
      })
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:folder:remote-workspace',
      expect.not.objectContaining({ command: expect.anything() })
    )
  })
})
