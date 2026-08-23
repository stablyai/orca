import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

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
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_remote_worker',
      paneKey: 'tab_remote:leaf_remote',
      processIncarnation: 'runtime_test:term_remote_worker:1',
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)
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
        taskSpec: 'remote cursor worker',
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

    // Why: assert the worker actually reached ready — a spy-only assertion would
    // stay green even if every stage after terminal_create regressed.
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' },
        effective: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }
      }
    })
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

  it('closes a created agent terminal when stable authority cannot be recorded', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      tabId: 'tab_remote',
      ptyKilled: true
    })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!

    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_missing_authority',
        taskId: 'task_missing_authority',
        taskSpec: 'remote worker',
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_missing_authority',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'missing_authority_payload'
        }
      }
    )) as { state: string; failedStage?: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'terminal_create',
      lastError: 'stable_pane_required'
    })
    expect(closeTerminal).toHaveBeenCalledWith('term_remote_worker')
    const attachment = db.getRemoteDispatchAttachment('ctx_missing_authority')!
    expect(JSON.parse(attachment.effects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          id: 'term_remote_worker',
          action: 'closed_after_failed_start'
        })
      ])
    )
    expect(JSON.parse(attachment.residual_resources)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'term_remote_worker' })])
    )
  })
})
