import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { createManagedCliContext } from '../../../../../../shared/managed-cli-context'
import { ORCHESTRATION_METHODS } from '../../orchestration'

// Why: a federated worker terminal is created from an agent id. Passing that id
// as a shell command launched Cursor's desktop app instead of `cursor-agent`
// (issue #11926), so the remote path must resolve through the TUI agent config
// exactly like the local one.
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
    // Why: without a stable pane the handler bails at agent_readiness, so the
    // assertions below would pass against a worker that never actually started.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'preflightWorktreeManagedCliExecutable').mockReturnValue('orca')
    vi.spyOn(runtime, 'assertTerminalManagedCliAvailable').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      tabId: 'tab_remote'
    } as never)
    // Why: the attach path proves the worker's managed-CLI identity from a live pty
    // record, which a spied createTerminal never registers.
    vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockImplementation((handle) =>
      createManagedCliContext({
        executable: 'orca',
        runtimeId: runtime.getRuntimeId(),
        executionHostId: 'local',
        workspaceKey: 'folder:remote-workspace',
        terminalHandle: handle
      })
    )
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
        attemptId: 'attempt_ctx_remote',
        runId: 'run_ctx_remote',
        coordinatorGeneration: 1,
        taskSpec: 'remote cursor worker',
        depth: 2,
        protocolVersion: 4,
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

    // Why: assert the worker actually reached ready — a spy-only assertion would
    // stay green even if every stage after terminal_create regressed.
    expect({ failedStage: result.failedStage, lastError: result.lastError }).toEqual({
      failedStage: undefined,
      lastError: undefined
    })
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
        launchPreferences: expect.objectContaining({ model: 'gpt-5.3-codex', effort: 'high' })
      })
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:folder:remote-workspace',
      expect.not.objectContaining({ command: expect.anything() })
    )
  })
})
