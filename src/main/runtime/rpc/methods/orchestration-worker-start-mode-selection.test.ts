/**
 * End of the seam: `orchestration.workerStart` reads the user's own setting and starts the worker
 * that setting describes. No flag reaches this decision, and no combination refuses the start.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const STRUCTURED_HANDLE = 'structworker_abc'
const TERMINAL_HANDLE = 'term_worker'

const createStructuredWorkerSessionForWorktree = vi.fn(
  async (args: { effects: { kind: string }[] }) => {
    args.effects.push({ kind: 'terminal' })
    return { identity: { handle: STRUCTURED_HANDLE, sessionId: 'sess_1' }, host: {} }
  }
)
const createExistingWorktreeWorkerTerminal = vi.fn(async () => ({ handle: TERMINAL_HANDLE }))

vi.mock('./orchestration/worker/worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStructuredWorkerSessionForWorktree: (args: never) =>
    createStructuredWorkerSessionForWorktree(args),
  createExistingWorktreeWorkerTerminal: () => createExistingWorktreeWorkerTerminal()
}))
vi.mock('./orchestration/federation/federated-worker-start', () => ({
  startFederatedWorker: async () => ({ state: 'ready', dispatchId: 'ctx_remote' })
}))
vi.mock('./orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: async () => {},
  releaseStructuredWorkerSession: () => {},
  discardStructuredWorkerSession: async () => {}
}))

const STRUCTURED_DEFAULT = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}

describe('worker-start honours the settings default', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    createStructuredWorkerSessionForWorktree.mockClear()
    createExistingWorktreeWorkerTerminal.mockClear()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Settings-driven worker mode',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : `tab_worker:${handle}`
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:worker:1')
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::wt',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::wt',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function startWorker(
    settings: Record<string, unknown> | null,
    overrides: Record<string, unknown> = {}
  ) {
    vi.spyOn(runtime, 'getClientSettings').mockImplementation(() => {
      if (!settings) {
        throw new Error('runtime_unavailable')
      }
      return settings as never
    })
    const task = db.createTask({ spec: 'settings-driven task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )!
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'current',
      agent: 'claude',
      ...overrides
    })
    return (await method.handler(params, { runtime })) as {
      state: string
      mode: { mode: string; preferred: string; reason: string; detail: string }
    }
  }

  function mockWorktreeCreation() {
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::wt',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({ terminals: [] } as never)
    return vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(
      async (createArgs) =>
        ({
          worktree: { id: 'repo::child', repoId: 'repo' },
          ...(createArgs.startupAgent
            ? { startupTerminal: { spawned: true, handle: TERMINAL_HANDLE } }
            : {}),
          setupReceipt: {
            hookFound: false,
            startupPolicy: 'start-immediately',
            state: 'not_configured'
          }
        }) as never
    )
  }

  it('starts a structured chat worker when structured native chat is the default', async () => {
    const result = await startWorker(STRUCTURED_DEFAULT)

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'structured', preferred: 'structured', reason: 'user_default' }
    })
    expect(createStructuredWorkerSessionForWorktree).toHaveBeenCalledTimes(1)
    expect(createExistingWorktreeWorkerTerminal).not.toHaveBeenCalled()
  })

  it('starts a terminal agent worker when it is not', async () => {
    const result = await startWorker({
      ...STRUCTURED_DEFAULT,
      experimentalStructuredNativeChat: false
    })

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'terminal', preferred: 'terminal', reason: 'user_default' }
    })
    expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledTimes(1)
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
  })

  it('starts a terminal worker rather than failing when the host refuses a structured session', async () => {
    vi.mocked(runtime.getStructuredAgentSessionCreateSupport).mockResolvedValue({
      supported: false,
      reason: 'wsl'
    })

    const result = await startWorker(STRUCTURED_DEFAULT)

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'terminal', preferred: 'structured', reason: 'wsl_execution_runtime' }
    })
    expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledTimes(1)
  })

  it('still starts a worker when the runtime has no settings to read', async () => {
    const result = await startWorker(null)

    expect(result).toMatchObject({ state: 'ready', mode: { mode: 'terminal' } })
    expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledTimes(1)
  })

  it('seeds --model and --effort into the structured session instead of downgrading', async () => {
    // These two used to force a PTY worker, which is half of why orchestration never produced a
    // structured chat: choosing a model is the ordinary way to dispatch one.
    const result = await startWorker(STRUCTURED_DEFAULT, { model: 'opus', effort: 'high' })

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'structured', preferred: 'structured', reason: 'user_default' }
    })
    expect(createExistingWorktreeWorkerTerminal).not.toHaveBeenCalled()
    expect(createStructuredWorkerSessionForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ launchPreferences: { model: 'opus', effort: 'high' } })
    )
  })

  it('creates a new worktree WITHOUT an agent terminal and gives it a structured session', async () => {
    // The other half: `createWorkerWorktree` creates agent-first, so a `--worktree new-child`
    // dispatch could only ever end up a PTY terminal worker.
    const created = mockWorktreeCreation()

    const result = await startWorker(STRUCTURED_DEFAULT, {
      worktree: 'new-child',
      name: 'worker-child'
    })

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'structured', preferred: 'structured', reason: 'user_default' }
    })
    expect(created).toHaveBeenCalledWith(
      expect.not.objectContaining({ startupAgent: expect.anything() })
    )
    expect(createStructuredWorkerSessionForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'repo::child' })
    )
    expect(createExistingWorktreeWorkerTerminal).not.toHaveBeenCalled()
  })

  it('still creates the new worktree agent-first when the default is a terminal worker', async () => {
    const created = mockWorktreeCreation()

    const result = await startWorker(
      { ...STRUCTURED_DEFAULT, experimentalStructuredNativeChat: false },
      { worktree: 'new-child', name: 'worker-child' }
    )

    expect(result).toMatchObject({ state: 'ready', mode: { mode: 'terminal' } })
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ startupAgent: 'claude' }))
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
  })

  it('falls back to a terminal agent in the worktree it just created when the host refuses', async () => {
    // The host can only answer for a workspace that exists, so a created worktree settles its mode
    // after creation — and a refusal must not fail a routine dispatch.
    mockWorktreeCreation()
    vi.mocked(runtime.getStructuredAgentSessionCreateSupport).mockResolvedValue({
      supported: false,
      reason: 'wsl'
    })

    const result = await startWorker(STRUCTURED_DEFAULT, {
      worktree: 'new-child',
      name: 'worker-child'
    })

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'terminal', preferred: 'structured', reason: 'wsl_execution_runtime' }
    })
    expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledTimes(1)
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
  })

  it('tells a remote dispatch why its structured default did not apply', async () => {
    const result = await startWorker(STRUCTURED_DEFAULT, {
      on: 'server-1',
      worktree: 'repo::remote'
    })

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'terminal', preferred: 'structured', reason: 'remote_execution_host' }
    })
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
  })
})
