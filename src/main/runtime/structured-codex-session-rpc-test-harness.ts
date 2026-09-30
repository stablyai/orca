// One structured Codex session driven over `agentSession.*`, with nothing stubbed but the Codex
// child: the RPC dispatcher, schemas, record store, journal, lease, Codex adapter and translation
// are the ones that ship. The fake app-server answers the JSON-RPC calls the real one does, and a
// test pushes notifications, blocking requests and the child's exit back through its handlers.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

export const SESSION = 'session-integration-1'
export const THREAD = 'thread-integration'
export const TURN = 'turn-1'
const WORKSPACE = 'workspace-1'
// Without the pending-send capability the host holds the reply until the send settles, which is a
// shim for clients too old to render a pending bubble — not what these suites model.
const DEFAULT_CLIENT_CAPABILITIES: readonly RuntimeCapability[] = [
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
]

// `closed` is readonly on the real connection; the fake flips it so a test can
// see a takeover reap the previous child.
export type FakeCodexConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number }[]
  resumedThreadId: string | null
  launch: Parameters<typeof openCodexAppServerConnection>[0]
}

export type FakeCodex = {
  connections: FakeCodexConnection[]
  openConnection: typeof openCodexAppServerConnection
  live: () => FakeCodexConnection
  notify: (method: string, params: unknown) => void
  ask: (id: number, method: string, params: unknown) => void
}

function fakeCodex(): FakeCodex {
  const connections: FakeCodexConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeCodexConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      resumedThreadId: null,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: THREAD, path: '/rollouts/integration.jsonl' } }
        }
        if (method === 'thread/resume') {
          connection.resumedThreadId = (params as { threadId: string }).threadId
          return { thread: { id: connection.resumedThreadId } }
        }
        if (method === 'turn/start') {
          return { turn: { id: TURN } }
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: null
          }
        }
        return {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code) => connection.replies.push({ id, code }),
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  const live = (): FakeCodexConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no codex app-server has been opened')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    notify: (method, params) => live().handlers.onNotification?.(method, params),
    ask: (id, method, params) => live().handlers.onServerRequest?.({ id, method, params })
  }
}

function attachParams(operationId: () => string, fence: number | null) {
  const params = {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: 'codex' as const,
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME' as const, path: '/home/dev/.codex' },
    runtimeKind: 'native' as const,
    providerHandle: { kind: 'codex' as const, threadId: THREAD }
  }
  const envelope = {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: ''
  }
  return {
    ...params,
    envelope: {
      ...envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields({ ...params, envelope } as never)
      })
    }
  }
}

export type StructuredCodexRpcHarness = {
  codex: FakeCodex
  root: string
  hostConfig: () => Parameters<typeof ensureStructuredAgentSessionHost>[0]
  envelope: (
    method: string,
    fields: Record<string, unknown>,
    fence: number | null
  ) => { sessionId: string; clientOperationId: string; expectedRuntimeFence: number | null }
  createIntentParams: () => Record<string, unknown>
  /** Runs a one-shot method and returns its decoded reply. */
  call: (method: string, params: unknown) => Promise<RpcResponse>
  /** Asserts success and unwraps the host's `{ok:true, value}` mutation result. */
  ok: <T>(method: string, params: unknown) => Promise<T>
  dispose: () => Promise<void>
}

export async function openStructuredCodexRpcHarness(
  clientCapabilities: readonly RuntimeCapability[] = DEFAULT_CLIENT_CAPABILITIES
): Promise<StructuredCodexRpcHarness> {
  const client = { clientId: 'device-a', clientKind: 'runtime' as const, clientCapabilities }
  let operations = 0
  const root = await mkdtemp(join(tmpdir(), 'orca-structured-integration-'))
  const codex = fakeCodex()
  // `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. Real time, not a frozen
  // constant: the runtime under test stamps the ledger with its own clock and refuses a future id.
  const operationId = (): string => {
    operations += 1
    return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
  }
  const envelope: StructuredCodexRpcHarness['envelope'] = (method, fields, fence) => ({
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  const hostConfig = (): Parameters<typeof ensureStructuredAgentSessionHost>[0] => ({
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
    resolveCodexCommand: () => '/usr/local/bin/codex',
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveEnvironment: async () => ({
      PATH: '/shell/bin:/usr/bin',
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/shell/home'
    }),
    resolveCodexOverrides: () => ({ CODEX_PROFILE: 'configured' }),
    openCodexConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(operationId, null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost(hostConfig()).then(() => undefined),
    registerOwnedSubscriptionCleanup: vi.fn((_id: string, dispose: () => void) => ({
      releaseIfCurrent: dispose
    }))
  }
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
  const call: StructuredCodexRpcHarness['call'] = async (method, params) => {
    const replies: RpcResponse[] = []
    const request: RpcRequest = { id: `req-${operations}`, authToken: 'token', method, params }
    await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), client)
    const first = replies[0]
    if (!first) {
      throw new Error(`no reply for ${method}`)
    }
    return first
  }
  return {
    codex,
    root,
    hostConfig,
    envelope,
    createIntentParams: () => {
      const worktree = `id:${WORKSPACE}`
      const fields = { worktree, agent: 'codex' }
      return { envelope: envelope('agentSession.create', fields, null), ...fields }
    },
    call,
    ok: async <T>(method: string, params: unknown): Promise<T> => {
      const response = await call(method, params)
      expect(response, `${method} failed: ${JSON.stringify(response)}`).toMatchObject({ ok: true })
      const result = (response as { result: { ok: boolean; value?: T; refusal?: unknown } }).result
      expect(result, `${method} refused: ${JSON.stringify(result.refusal)}`).toMatchObject({
        ok: true
      })
      return result.value as T
    },
    dispose: async () => {
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  }
}
