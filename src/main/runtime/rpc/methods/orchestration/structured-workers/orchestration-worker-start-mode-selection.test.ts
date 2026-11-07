import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import '../../../../../../shared/protocol-version'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../../../../shared/orchestration-runtime-capabilities'
/** workerStart follows the user's launch preference without a mode flag; unsupported structured mode falls back rather than refusing routine dispatch. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'

import { ORCHESTRATION_METHODS } from '../orchestration'
import '../../../../orchestration/orchestration-error'
import type { RuntimeTerminalCreate } from '../../../../../../shared/runtime-terminal-create-contract'
import '../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'

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

vi.mock('../worker/worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStructuredWorkerSessionForWorktree: (args: never) =>
    createStructuredWorkerSessionForWorktree(args),
  createExistingWorktreeWorkerTerminal: () => createExistingWorktreeWorkerTerminal()
}))
vi.mock('../federation/federated-worker-start', () => ({
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
})
