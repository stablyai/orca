import type { WebSocket } from 'ws'
import {
  DESKTOP_PROTOCOL_VERSION,
  MIN_COMPATIBLE_MOBILE_VERSION
} from '../../src/shared/protocol-version'
import { handleMockGitRequest } from './mock-server-git-state'
import { createMockRepos, createMockWorktrees, readScenarioNumber } from './mobile-lag-scenario'

const MOCK_REPO_COUNT = readScenarioNumber('MOCK_REPO_COUNT', 2)
const MOCK_WORKTREE_COUNT = readScenarioNumber('MOCK_WORKTREE_COUNT', 2)
const MOCK_RPC_DELAY_MS = readScenarioNumber('MOCK_RPC_DELAY_MS', 0)

const FAKE_REPOS = createMockRepos(MOCK_REPO_COUNT)
let fakeWorktrees = createMockWorktrees(FAKE_REPOS, MOCK_WORKTREE_COUNT)

const FAKE_TERMINALS = [
  {
    handle: 'term-1',
    worktreeId: fakeWorktrees[0]?.worktreeId ?? 'repo-1::/tmp/orca-mobile-repro/orca',
    title: 'Claude — auth refactor',
    isActive: true,
    hasRunningProcess: true
  },
  {
    handle: 'term-2',
    worktreeId: fakeWorktrees[0]?.worktreeId ?? 'repo-1::/tmp/orca-mobile-repro/orca',
    title: 'zsh',
    isActive: false,
    hasRunningProcess: false
  }
]

const FAKE_SCROLLBACK = [
  '$ claude "refactor the auth module to use JWT tokens"',
  '',
  '⏳ Working on it...',
  '',
  "I'll refactor the auth module. Here's my plan:",
  '1. Replace session-based auth with JWT',
  '2. Add token refresh endpoint',
  '3. Update middleware',
  '',
  'Let me start by reading the current auth module...',
  ''
].join('\n')

const STREAMING_CHUNKS = [
  'Reading src/auth/middleware.ts...\n',
  'Reading src/auth/session.ts...\n',
  '\nI see the current implementation uses express-session.\n',
  "I'll replace it with jsonwebtoken.\n",
  '\nUpdating src/auth/middleware.ts...\n'
]

export type RpcRequest = {
  id: string
  method: string
  deviceToken?: string
  params?: Record<string, unknown>
}

export type RpcResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  streaming?: true
  _meta: { runtimeId: string }
}

export const mockScenarioSummary = {
  repoCount: FAKE_REPOS.length,
  worktreeCount: fakeWorktrees.length,
  rpcDelayMs: MOCK_RPC_DELAY_MS
}

export function success(id: string, result: unknown, streaming?: boolean): RpcResponse {
  const resp: RpcResponse = { id, ok: true, result, _meta: { runtimeId: 'mock-runtime' } }
  if (streaming) {
    resp.streaming = true
  }
  return resp
}

export function error(id: string, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message }, _meta: { runtimeId: 'mock-runtime' } }
}

function responseDelayFor(method: string): number {
  const methodOverride =
    process.env[`MOCK_RPC_DELAY_${method.replace(/\W/g, '_').toUpperCase()}_MS`]
  if (!methodOverride) {
    return MOCK_RPC_DELAY_MS
  }
  const parsed = Number(methodOverride)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : MOCK_RPC_DELAY_MS
}

function repoSelectorToId(repoSelector: unknown): string | null {
  if (typeof repoSelector !== 'string') {
    return null
  }
  return repoSelector.startsWith('id:') ? repoSelector.slice(3) : repoSelector
}

export function handleRequest(
  request: RpcRequest,
  send: (response: RpcResponse) => void,
  ws: WebSocket
): void {
  const respond = (response: RpcResponse) => {
    const delay = responseDelayFor(request.method)
    if (delay > 0) {
      setTimeout(() => send(response), delay)
      return
    }
    send(response)
  }

  if (handleMockGitRequest(request, respond, success)) {
    return
  }

  switch (request.method) {
    case 'status.get':
      respond(
        success(request.id, {
          runtimeId: 'mock-runtime',
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          minCompatibleMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION,
          graphStatus: 'ready',
          windowCount: 1,
          tabCount: 2,
          terminalCount: 2
        })
      )
      break

    case 'worktree.ps':
      respond(
        success(request.id, {
          worktrees: fakeWorktrees,
          totalCount: fakeWorktrees.length,
          truncated: false
        })
      )
      break

    case 'repo.list':
      respond(success(request.id, { repos: FAKE_REPOS }))
      break

    case 'settings.get':
      respond(
        success(request.id, {
          settings: {
            defaultTuiAgent: 'codex',
            disabledTuiAgents: [],
            agentCmdOverrides: {}
          }
        })
      )
      break

    case 'ui.get':
      respond(
        success(request.id, {
          ui: {
            groupBy: 'repo',
            sortBy: 'recent',
            hideSleepingWorkspaces: false,
            hideDefaultBranchWorkspace: false,
            filterRepoIds: [],
            collapsedGroups: [],
            trustedOrcaHooks: {}
          }
        })
      )
      break

    case 'ui.set':
      respond(success(request.id, { ok: true }))
      break

    case 'repo.hooks':
      respond(
        success(request.id, {
          hooks: null,
          source: null,
          setupRunPolicy: 'run-by-default',
          setupTrust: null
        })
      )
      break

    case 'preflight.detectAgents':
    case 'preflight.detectRemoteAgents':
      respond(success(request.id, ['claude', 'codex', 'gemini']))
      break

    case 'ssh.getState':
    case 'ssh.connect': {
      const targetId = String(request.params?.targetId ?? '')
      respond(
        success(request.id, {
          state: {
            targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        })
      )
      break
    }

    case 'worktree.create': {
      const repoId = repoSelectorToId(request.params?.repo) ?? FAKE_REPOS[0]?.id ?? 'repo-1'
      const repo = FAKE_REPOS.find((candidate) => candidate.id === repoId) ?? FAKE_REPOS[0]
      const name = String(request.params?.name ?? `mock-${fakeWorktrees.length + 1}`)
      const created = createMockWorktrees(repo ? [repo] : FAKE_REPOS, 1)[0]
      const next =
        created && repo
          ? {
              ...created,
              worktreeId: `${repo.id}::${repo.path}/worktrees/${name}`,
              repoId: repo.id,
              repo: repo.displayName,
              path: `${repo.path}/worktrees/${name}`,
              branch: `feature/${name}`,
              displayName: name,
              isActive: true
            }
          : null
      if (next) {
        fakeWorktrees = [next, ...fakeWorktrees.map((w) => ({ ...w, isActive: false }))]
        mockScenarioSummary.worktreeCount = fakeWorktrees.length
      }
      respond(
        success(request.id, {
          worktree: {
            id: next?.worktreeId ?? `repo-1::/tmp/orca-mobile-repro/${name}`,
            worktreeId: next?.worktreeId
          }
        })
      )
      break
    }

    case 'worktree.activate': {
      const selector = String(request.params?.worktree ?? '')
      const id = selector.startsWith('id:') ? selector.slice(3) : selector
      fakeWorktrees = fakeWorktrees.map((w) => ({ ...w, isActive: w.worktreeId === id }))
      respond(success(request.id, { ok: true }))
      break
    }

    case 'terminal.list':
      respond(
        success(request.id, {
          terminals: FAKE_TERMINALS,
          totalCount: FAKE_TERMINALS.length,
          truncated: false
        })
      )
      break

    case 'terminal.subscribe': {
      respond(success(request.id, { type: 'scrollback', lines: FAKE_SCROLLBACK, truncated: false }))

      let chunkIndex = 0
      const interval = setInterval(() => {
        if (chunkIndex >= STREAMING_CHUNKS.length || ws.readyState !== ws.OPEN) {
          clearInterval(interval)
          if (ws.readyState === ws.OPEN) {
            respond(success(request.id, { type: 'end' }))
          }
          return
        }
        respond(success(request.id, { type: 'data', chunk: STREAMING_CHUNKS[chunkIndex] }, true))
        chunkIndex++
      }, 500)
      break
    }

    case 'terminal.send':
      respond(success(request.id, { send: { handle: 'term-1', ok: true } }))
      break

    case 'terminal.unsubscribe':
      respond(success(request.id, { unsubscribed: true }))
      break

    case 'files.open':
    case 'files.openDiff':
      respond(
        success(request.id, {
          worktree: request.params?.worktree ?? 'id:mock',
          relativePath: request.params?.relativePath ?? '',
          kind: 'text',
          opened: true
        })
      )
      break

    default:
      respond(error(request.id, 'method_not_found', `Unknown method: ${request.method}`))
  }
}
