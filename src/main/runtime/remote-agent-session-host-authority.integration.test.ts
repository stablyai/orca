import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import type {
  RuntimeEnsureAgentSessionResult,
  RuntimeEnsureAgentSessionRequest
} from '../../shared/agent-session-host-authority'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { SubprocessHandle } from '../daemon/session'
import { TerminalHost } from '../daemon/terminal-host'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const TEST_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 5_000

type ControlledSubprocess = SubprocessHandle & { exit: (code?: number) => void }

function createControlledSubprocess(): ControlledSubprocess {
  let onExit: ((code: number) => void) | null = null
  let exited = false
  const exit = (code = 0): void => {
    if (exited) {
      return
    }
    exited = true
    onExit?.(code)
  }
  return {
    pid: 41_000,
    getForegroundProcess: () => (exited ? null : 'claude'),
    write: vi.fn(),
    resize: vi.fn(),
    kill: () => exit(0),
    forceKill: () => exit(137),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (listener) => {
      onExit = listener
    },
    dispose: vi.fn(),
    exit
  }
}

function requirePairing(server: OrcaRuntimeRpcServer, name: string) {
  const offer = server.createPairingOffer({ name, scope: 'runtime' })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('invalid pairing')
  }
  return pairing
}

describe('remote agent-session host authority integration', () => {
  const cleanups: (() => void | Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it(
    'deduplicates racing remote resumes, adopts retries, and retires exited surfaces',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-authority-repro-'))
      cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))

      const subprocesses: ControlledSubprocess[] = []
      const spawnSubprocess = vi.fn(() => {
        const subprocess = createControlledSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      })
      const host = new TerminalHost({ spawnSubprocess })
      cleanups.push(() => host.dispose())

      const store = {
        getSettings: () => ({
          workspaceDir: userDataPath,
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          disabledTuiAgents: [],
          agentCmdOverrides: {},
          agentDefaultArgs: {},
          agentDefaultEnv: {}
        }),
        getRepos: () => [],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getProjects: () => []
      }
      const runtime = new OrcaRuntimeService(store as never)
      let nextRequestedSession = 0
      runtime.setPtyController({
        spawn: async (options) => {
          const requestedSessionId = `remote-repro-${++nextRequestedSession}`
          let resolvedSessionId = requestedSessionId
          const result = await host.createOrAttach({
            sessionId: requestedSessionId,
            cols: options.cols,
            rows: options.rows,
            cwd: options.cwd,
            env: options.env,
            command: options.command,
            startupCommandDelivery: options.startupCommandDelivery,
            launchAgent: options.launchAgent,
            agentSessionEnsure: options.agentSessionEnsure,
            streamClient: {
              onData: (data) => runtime.onPtyData(resolvedSessionId, data, Date.now()),
              onExit: (code) => runtime.onPtyExit(resolvedSessionId, code)
            },
            onSessionResolved: (sessionId) => {
              resolvedSessionId = sessionId
            }
          })
          return {
            id: result.agentSessionEnsure?.owner.ptyId ?? resolvedSessionId,
            ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
          }
        },
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'claude'
      })

      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      await server.start()
      cleanups.push(() => server.stop())

      const firstClient = new RemoteRuntimeRequestConnection(requirePairing(server, 'client-one'))
      const secondClient = new RemoteRuntimeRequestConnection(requirePairing(server, 'client-two'))
      const retryClient = new RemoteRuntimeRequestConnection(requirePairing(server, 'retry-client'))
      cleanups.push(() => firstClient.close())
      cleanups.push(() => secondClient.close())
      cleanups.push(() => retryClient.close())

      const request: RuntimeEnsureAgentSessionRequest = {
        kind: 'explicit',
        worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}`,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'provider-session-repro' },
        presentation: 'background'
      }
      const [first, second] = await Promise.all([
        firstClient.request<RuntimeEnsureAgentSessionResult>(
          'terminal.ensureAgentSession',
          request,
          REQUEST_TIMEOUT_MS
        ),
        secondClient.request<RuntimeEnsureAgentSessionResult>(
          'terminal.ensureAgentSession',
          request,
          REQUEST_TIMEOUT_MS
        )
      ])

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) {
        throw new Error('structured resume failed')
      }
      expect([first.result.disposition, second.result.disposition].sort()).toEqual([
        'adopted',
        'created'
      ])
      expect(second.result.terminal).toMatchObject({
        handle: first.result.terminal.handle,
        tabId: first.result.terminal.tabId,
        paneKey: first.result.terminal.paneKey,
        ptyId: first.result.terminal.ptyId
      })
      expect(spawnSubprocess).toHaveBeenCalledOnce()
      expect(host.listSessions()).toHaveLength(1)

      // Why: a retry cannot prove whether its previous response arrived, so
      // the provider identity—not a new client operation—must recover the owner.
      const retry = await retryClient.request<RuntimeEnsureAgentSessionResult>(
        'terminal.ensureAgentSession',
        request,
        REQUEST_TIMEOUT_MS
      )
      expect(retry).toMatchObject({
        ok: true,
        result: {
          disposition: 'adopted',
          terminal: {
            handle: first.result.terminal.handle,
            tabId: first.result.terminal.tabId,
            paneKey: first.result.terminal.paneKey,
            ptyId: first.result.terminal.ptyId
          }
        }
      })
      expect(spawnSubprocess).toHaveBeenCalledOnce()

      subprocesses[0]?.exit(0)
      await vi.waitFor(async () => {
        const [terminals, tabs] = await Promise.all([
          firstClient.request<{ terminals: unknown[] }>(
            'terminal.list',
            { worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` },
            REQUEST_TIMEOUT_MS
          ),
          secondClient.request<RuntimeMobileSessionTabsResult>(
            'session.tabs.list',
            { worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` },
            REQUEST_TIMEOUT_MS
          )
        ])
        expect(terminals).toMatchObject({ ok: true, result: { terminals: [] } })
        expect(tabs).toMatchObject({ ok: true, result: { tabs: [] } })
      })
    }
  )
})
