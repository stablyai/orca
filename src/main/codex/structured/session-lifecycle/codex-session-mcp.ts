import {
  agentSessionMcpWebUrl,
  type AgentSessionMcpResult,
  type AgentSessionMcpServer
} from '../../../../shared/agent-session/options/protocol/agent-session-mcp'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../../codex-cli/codex-home-process-lock'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  CODEX_MCP_RPC_TIMEOUT_MS,
  CODEX_MCP_TOML_KEY,
  isRecord,
  listCodexMcpServers,
  type CodexMcpRequest
} from './codex-mcp-server-status'
import { codexMirrorSourceDeclaring, writeCodexMcpEnabled } from './codex-mcp-enabled-write'
import {
  deliverCodexMcpCallback,
  matchingCodexMcpCallback,
  readRedirectUri
} from './codex-mcp-sign-in-callback'
import {
  runCodexProviderAppServer,
  type CodexProviderInvocationDeps
} from './codex-provider-session-rename'
import type { CodexSession } from './codex-structured-session-state'

const COLD_MCP_TIMEOUT_MS = 60_000
// Codex's own default login window; its callback listener closes after it.
const SIGN_IN_WINDOW_SECONDS = 300
// Codex's own server-name rule (codex-mcp validate_mcp_server_name).
const SERVER_NAME = /^[\w:@/.-]+$/
const MISMATCH = "That address doesn't match the sign-in in progress."

type PendingSignIn = {
  server: string
  redirectUri: string | null
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

export type CodexSessionMcpManager = NonNullable<StructuredAgentSessionAdapter['manageMcp']> & {
  forget: (sessionId: string) => void
}

type CodexLogin = { authorizationUrl: string }

/** The `/mcp` panel's reads and actions: on the chat's own app-server while it runs, otherwise on
 *  a short-lived one launched as the chat is, without resuming the thread. */
export function manageCodexSessionMcp(
  sessions: Map<string, CodexSession>,
  readInvocation: () => CodexProviderInvocationDeps | undefined
): CodexSessionMcpManager {
  const signIns = new Map<string, PendingSignIn>()
  const clearSignIn = (sessionId: string): void => {
    const existing = signIns.get(sessionId)
    if (!existing) {
      return
    }
    clearTimeout(existing.timer)
    signIns.delete(sessionId)
  }
  const pruneExpiredSignIns = (now: number): void => {
    for (const [sessionId, pending] of signIns) {
      if (pending.expiresAt <= now) {
        clearSignIn(sessionId)
      }
    }
  }
  const invocationFor = (): CodexProviderInvocationDeps => {
    const invocation = readInvocation()
    if (!invocation) {
      throw new Error('Codex MCP invocation is not configured')
    }
    return invocation
  }

  const cold = <T>(
    record: AgentSessionRecord,
    body: (request: CodexMcpRequest, cwd: string) => Promise<T>,
    codexHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
  ): Promise<T> =>
    withCodexHomeProcessLock(resolveCodexHomeProcessLockKey(codexHome), () =>
      runCodexProviderAppServer(
        record,
        invocationFor(),
        { timeoutMs: COLD_MCP_TIMEOUT_MS, experimentalApi: true, codexHome },
        (rpc, cwd) => body(rpc.request, cwd)
      )
    )

  const list = (
    record: AgentSessionRecord,
    live: CodexSession | null
  ): Promise<AgentSessionMcpServer[]> => {
    if (live) {
      return listLive(live)
    }
    return cold(record, (request, cwd) => listCodexMcpServers(request, { threadId: null, cwd }))
  }

  const toggle = async (
    record: AgentSessionRecord,
    live: CodexSession | null,
    server: string,
    enabled: boolean
  ): Promise<AgentSessionMcpServer[]> => {
    const codexHome =
      live?.codexHome ?? requireLegacyAgentSessionAccountHome(record.accountHome).path
    const source = codexMirrorSourceDeclaring(codexHome, server)
    if (source) {
      await cold(record, (request) => writeCodexMcpEnabled(request, server, enabled), source)
    }
    if (live) {
      await writeCodexMcpEnabled(liveRequest(live), server, enabled)
      return listLive(live)
    }
    return cold(record, async (request, cwd) => {
      await writeCodexMcpEnabled(request, server, enabled)
      return listCodexMcpServers(request, { threadId: null, cwd })
    })
  }

  const manage: NonNullable<StructuredAgentSessionAdapter['manageMcp']> = async (
    record,
    operation
  ) => {
    const live = liveSession(sessions, record.sessionId)
    if (operation.action === 'status') {
      return ok(await list(record, live))
    }
    if (!SERVER_NAME.test(operation.server)) {
      throw new Error(`No MCP server named '${operation.server}'.`)
    }
    switch (operation.action) {
      case 'signIn': {
        // Codex's callback listener lives in the app-server, which only a running chat keeps up.
        if (!live) {
          clearSignIn(record.sessionId)
          return { status: 'not-running' }
        }
        const login = await requestLogin(liveRequest(live), operation.server, live.threadId)
        const servers = await listLive(live)
        // The URL comes from the MCP server's OAuth metadata; clients open only web pages.
        const url = agentSessionMcpWebUrl(login.authorizationUrl)
        clearSignIn(record.sessionId)
        if (!url) {
          return ok(servers)
        }
        const ttlMs = SIGN_IN_WINDOW_SECONDS * 1000
        const entry: PendingSignIn = {
          server: operation.server,
          redirectUri: readRedirectUri(login.authorizationUrl),
          expiresAt: Date.now() + ttlMs,
          timer: setTimeout(() => {
            if (signIns.get(record.sessionId) === entry) {
              signIns.delete(record.sessionId)
            }
          }, ttlMs)
        }
        entry.timer.unref?.()
        signIns.set(record.sessionId, entry)
        return {
          status: 'ok',
          servers,
          signIn: { server: operation.server, url, finish: 'callback' }
        }
      }
      case 'finishSignIn': {
        const now = Date.now()
        pruneExpiredSignIns(now)
        if (!live) {
          clearSignIn(record.sessionId)
        }
        const pending = signIns.get(record.sessionId)
        const callback =
          pending && pending.server === operation.server && pending.expiresAt > now
            ? matchingCodexMcpCallback(operation.callbackUrl, pending.redirectUri)
            : null
        if (!callback) {
          throw new Error(MISMATCH)
        }
        await deliverCodexMcpCallback(callback)
        clearSignIn(record.sessionId)
        return ok(await list(record, live))
      }
      case 'reconnect': {
        if (!live) {
          return { status: 'not-running' }
        }
        await liveRequest(live)('config/mcpServer/reload', undefined, {
          timeoutMs: CODEX_MCP_RPC_TIMEOUT_MS
        })
        return ok(await listLive(live))
      }
      case 'toggle':
        if (!CODEX_MCP_TOML_KEY.test(operation.server)) {
          throw new Error(`Orca can't turn ${operation.server} on or off.`)
        }
        return ok(await toggle(record, live, operation.server, operation.enabled))
    }
  }
  return Object.assign(manage, { forget: clearSignIn })
}

const ok = (servers: AgentSessionMcpServer[]): AgentSessionMcpResult => ({ status: 'ok', servers })

function liveSession(sessions: Map<string, CodexSession>, sessionId: string): CodexSession | null {
  const session = sessions.get(sessionId)
  return session && !session.ended && !session.connection.closed ? session : null
}

const liveRequest =
  (live: CodexSession): CodexMcpRequest =>
  (method, params, options) =>
    live.connection.request(method, params, options)

const listLive = (live: CodexSession): Promise<AgentSessionMcpServer[]> =>
  listCodexMcpServers(liveRequest(live), {
    threadId: live.threadId,
    cwd: live.permissions?.cwd ?? null
  })

async function requestLogin(
  request: CodexMcpRequest,
  name: string,
  threadId: string | null
): Promise<CodexLogin> {
  const reply = await request(
    'mcpServer/oauth/login',
    { name, timeoutSecs: SIGN_IN_WINDOW_SECONDS, ...(threadId ? { threadId } : {}) },
    { timeoutMs: CODEX_MCP_RPC_TIMEOUT_MS }
  )
  const authorizationUrl = readStringField(reply, 'authorizationUrl')
  if (!authorizationUrl) {
    throw new Error(`Codex did not start a sign-in for ${name}.`)
  }
  return { authorizationUrl }
}

function readStringField(value: unknown, key: string): string | null {
  const field = isRecord(value) ? value[key] : null
  return typeof field === 'string' ? field : null
}
