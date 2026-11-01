import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
/** workerStart follows the user's launch preference without a mode flag; unsupported structured mode falls back rather than refusing routine dispatch. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { OPENCODE_MODEL_VERSION_REFUSAL } from '../../../../shared/agent-launch-model-preferences'

const STRUCTURED_HANDLE = 'structworker_abc'
// A real Orca session ID: a minted worker's preamble names it by this, not its handle.
const STRUCTURED_SESSION_ID = '9c2e4b7a-1d3f-4a6e-8b5c-7f0a2d9e6c41'
const TERMINAL_HANDLE = 'term_worker'

const createStructuredWorkerSessionForWorktree = vi.fn(
  async (args: { effects: { kind: string }[] }) => {
    args.effects.push({ kind: 'terminal' })
    return { identity: { handle: STRUCTURED_HANDLE, sessionId: STRUCTURED_SESSION_ID }, host: {} }
  }
)
const createExistingWorktreeWorkerTerminal = vi.fn<
  () => Promise<Partial<RuntimeTerminalCreate> & { handle: string }>
>(async () => ({ handle: TERMINAL_HANDLE }))
const sendStructuredWorkerPreamble = vi.fn(async (_args: { preamble: string }) => 'accepted')

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
  sendStructuredWorkerPreamble: (args: { preamble: string }) => sendStructuredWorkerPreamble(args),
  releaseStructuredWorkerSession: () => {},
  discardStructuredWorkerSession: async () => {}
}))

const STRUCTURED_DEFAULT = {
  agentDefaultSurface: 'chat',
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
    sendStructuredWorkerPreamble.mockClear()
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
    vi.spyOn(runtime, 'requireStore').mockImplementation(() => {
      if (!settings) {
        throw new Error('runtime_unavailable')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this worker fixture reaches only the private store getSettings reader.
      return { getSettings: () => settings } as never
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

  it.each(['fresh', 'reattach', 'adopted'] as const)(
    'uses actual %s creation for a terminal worker readiness failure',
    async (context) => {
      createExistingWorktreeWorkerTerminal.mockResolvedValueOnce({
        handle: TERMINAL_HANDLE,
        ptyId: 'pty-created',
        incarnationId: 'inc-created',
        worktreeId: 'repo::wt',
        title: null,
        ...(context === 'reattach' ? { isReattach: true as const } : {}),
        ...(context === 'adopted' ? { agentSessionDisposition: 'adopted' as const } : {})
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
      vi.mocked(runtime.waitForTerminal).mockResolvedValue({
        handle: TERMINAL_HANDLE,
        condition: 'tui-idle',
        satisfied: false,
        status: 'exited',
        exitCode: 256,
        exitCause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      await expect(
        startWorker({
          ...STRUCTURED_DEFAULT,
          nativeChatProviders: { claude: false, codex: false }
        })
      ).resolves.toMatchObject({
        state: 'failed',
        failedStage: 'agent_readiness',
        lastError:
          context === 'fresh'
            ? expect.stringContaining('Close some Git Bash terminals')
            : expect.not.stringContaining('Git Bash')
      })
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )

  it('starts a structured chat worker when structured native chat is the default', async () => {
    const result = await startWorker(STRUCTURED_DEFAULT)

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'structured', preferred: 'structured', reason: 'user_default' }
    })
    expect(createStructuredWorkerSessionForWorktree).toHaveBeenCalledTimes(1)
    expect(createExistingWorktreeWorkerTerminal).not.toHaveBeenCalled()
    const preamble = sendStructuredWorkerPreamble.mock.calls[0]![0].preamble
    expect(preamble).toContain(`Your Orca session ID is: orca_session_id:${STRUCTURED_SESSION_ID}`)
    expect(preamble).toContain('The coordinator cannot see this chat')
    expect(preamble).toContain('More supervised work arrives in this chat')
    expect(preamble).not.toContain('this terminal')
    expect(preamble).not.toMatch(/exit the shell/i)
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  // Two sequential CLI subprocesses each allow 15s, plus RPC setup and cleanup.
  it('runs the real worker-start CLI through RPC and production saved-choice mode selection', async () => {
    const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
    const { bin } = z
      .object({ bin: z.object({ bun: z.string() }) })
      .parse(JSON.parse(readFileSync(manifest, 'utf8')))
    const root = mkdtempSync(join(tmpdir(), 'orca-worker-cli-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\worker-${randomUUID()}` : join(root, 'rpc')
    let settings: Record<string, unknown> = {}
    vi.spyOn(runtime, 'requireStore').mockImplementation(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture reaches only getSettings.
      return { getSettings: () => settings } as never
    })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )!
    const requests: string[] = []
    const server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', async (chunk: string) => {
        buffer += chunk
        if (!buffer.includes('\n')) {
          return
        }
        const request = z
          .object({
            id: z.string(),
            method: z.string(),
            authToken: z.literal('fixture-token'),
            params: z.record(z.string(), z.unknown()).default({})
          })
          .parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
        requests.push(request.method)
        try {
          const result =
            request.method === 'status.get'
              ? { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] }
              : await method.handler(method.params!.parse(request.params), { runtime })
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result,
              _meta: { runtimeId: 'fixture-host' }
            })}\n`
          )
        } catch (error) {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: { code: 'fixture_failure', message: String(error) },
              _meta: { runtimeId: 'fixture-host' }
            })}\n`
          )
        }
      })
    })
    try {
      await new Promise<void>((ready) => server.listen(endpoint, ready))
      writeFileSync(
        join(root, 'orca-runtime.json'),
        JSON.stringify({
          runtimeId: 'fixture-host',
          pid: process.pid,
          startedAt: 1,
          authToken: 'fixture-token',
          transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
        })
      )
      const env = {
        ...Object.fromEntries(
          'HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ORCA_E2E_HOME_DIR ORCA_E2E_USER_DATA_DIR ORCA_USER_DATA_PATH TEMP TMP TMPDIR'
            .split(' ')
            .map((key) => [key, root])
        ),
        CODEX_HOME: join(root, 'codex'),
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec
      }
      for (const chat of [false, true]) {
        settings = {
          ...STRUCTURED_DEFAULT,
          agentDefaultSurface: chat ? 'chat' : 'terminal',
          nativeChatProviders: { codex: !chat }
        }
        const task = db.createTask({ spec: 'CLI saved-choice dispatch', runId })
        const response = await runProcess({
          program: join(dirname(manifest), bin.bun),
          args: [
            resolve('src/cli/index.ts'),
            'orchestration',
            'worker-start',
            '--task',
            task.id,
            '--worktree',
            'current',
            '--agent',
            'claude',
            '--from',
            'term_coord',
            '--json'
          ],
          cwd: root,
          env,
          timeoutMs: 15_000
        })
        expect(response.code, response.stderr + response.stdout).toBe(0)
        expect(JSON.parse(response.stdout)).toMatchObject({
          result: { state: 'ready', mode: chat ? 'structured' : 'terminal' }
        })
      }
      expect(requests.filter((name) => name === 'orchestration.workerStart')).toHaveLength(2)
      expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledOnce()
      expect(createStructuredWorkerSessionForWorktree).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('starts a terminal agent worker when it is not', async () => {
    const result = await startWorker({})

    expect(result).toMatchObject({
      state: 'ready',
      mode: { mode: 'terminal', preferred: 'terminal', reason: 'user_default' }
    })
    expect(createExistingWorktreeWorkerTerminal).toHaveBeenCalledTimes(1)
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
    const preamble = vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]![1]
    expect(preamble).toContain('The coordinator cannot see this terminal')
    expect(preamble).toContain('Do not exit the shell. More supervised work arrives here')
    expect(preamble).not.toContain('this chat')
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
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
    // Model/effort used to force PTY mode, preventing routine structured dispatch.
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

  it.each([false, true])(
    'keeps OpenCode version refusal before worker effects with native default %s',
    async (opencode) => {
      const dispatch = vi.spyOn(db, 'createStartingWorkerDispatch')
      vi.spyOn(runtime, 'probeOrchestrationOpenCodeModelLaunchSupport').mockRejectedValue(
        new OrchestrationError('capability_unsupported', OPENCODE_MODEL_VERSION_REFUSAL)
      )
      await expect(
        startWorker(
          { ...STRUCTURED_DEFAULT, nativeChatProviders: { opencode } },
          { agent: 'opencode', model: 'opencode/fledge-alpha-free' }
        )
      ).rejects.toMatchObject({
        code: 'capability_unsupported',
        message: OPENCODE_MODEL_VERSION_REFUSAL
      })
      expect(dispatch).not.toHaveBeenCalled()
      expect(createExistingWorktreeWorkerTerminal).not.toHaveBeenCalled()
      expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
    }
  )

  it('creates a new worktree WITHOUT an agent terminal and gives it a structured session', async () => {
    // Agent-first new worktrees previously made structured mode unreachable.
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
      { ...STRUCTURED_DEFAULT, nativeChatProviders: { claude: false, codex: false } },
      { worktree: 'new-child', name: 'worker-child' }
    )

    expect(result).toMatchObject({ state: 'ready', mode: { mode: 'terminal' } })
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ startupAgent: 'claude' }))
    expect(createStructuredWorkerSessionForWorktree).not.toHaveBeenCalled()
  })

  it('falls back to a terminal agent in the worktree it just created when the host refuses', async () => {
    // Resolve mode after creation, when workspace support is knowable; unsupported preference must still dispatch.
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
