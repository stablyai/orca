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

  it('creates the remote worker terminal from the agent id, never as a command', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::remote-worktree'
    } as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::remote-worktree',
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
        protocolVersion: 1,
        worktree: 'id:repo::remote-worktree',
        agent: 'cursor'
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
    )) as { state: string; failedStage?: string; lastError?: string }

    // Why: assert the worker actually reached ready — a spy-only assertion would
    // stay green even if every stage after terminal_create regressed.
    expect(result).toMatchObject({ state: 'ready' })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:repo::remote-worktree',
      expect.objectContaining({ startupAgent: 'cursor' })
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:repo::remote-worktree',
      expect.not.objectContaining({ command: expect.anything() })
    )
  })
})
