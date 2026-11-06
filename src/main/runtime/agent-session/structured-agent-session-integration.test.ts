import '../rpc/unused-default-rpc-methods.test-fixture'
import { scriptedCodexCatalogSession } from '../scripted-codex-model-catalog.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../../codex/app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from '../../codex/app-server/codex-app-server-connection'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../ipc/desktop-renderer-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-create-capabilities'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { attachFingerprintFields } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-attach'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import { RpcDispatcher } from '../rpc/dispatcher'
import type { NativeChatShellEnvironmentPolicy } from '../../../shared/native-chat/native-chat-shell-environment'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../rpc/methods/structured-sessions/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { scriptedCodexTransport } from '../orca-runtime-tests/scripted-codex-transport.test-fixture'

const journals = createTrackedJournalOpener()

const SESSION = 'session-integration-1'
const THREAD = 'thread-integration'
const TURN = 'turn-1'
const WORKSPACE = 'workspace-1'
const JOURNAL_IDENTITY = {
  sessionId: SESSION,
  workspaceId: WORKSPACE,
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle(THREAD)
}
// Use current pending-send capability; older clients wait for settlement because they cannot render pending bubbles.
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.filter(
    (capability) => capability !== AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  )
}

type CodexScript = {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  live: () => FakeConnection
  notify: (method: string, params: unknown) => void
  ask: (id: number, method: string, params: unknown) => void
}

// `closed` is readonly on the real connection; the fake flips it so the test can
// see the takeover reap the previous child.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number }[]
  resumedThreadId: string | null
  launch: Parameters<typeof openCodexAppServerConnection>[0]
}

function fakeCodex(): CodexScript {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      resumedThreadId: null,
      pid: 4321,
      closed: false,
      get closeResult(): CodexAppServerConnection['closeResult'] {
        return connection.closed ? { root: 'exited', tree: 'exited' } : null
      },
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/goal/get') {
          return { goal: null }
        }
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
  const live = (): FakeConnection => {
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

let operations = 0

/** Use ledger-shaped ids with its real clock; future-dated ids are refused. */
function operationId(): string {
  operations += 1
  return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
}

function envelope(method: string, fields: Record<string, unknown>, fence: number | null) {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function attachParams(fence: number | null) {
  const params = {
    location: {
      executionHostId: 'local' as const,
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
  const mutation = envelope('agentSession.attach', {}, fence)
  mutation.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: SESSION,
    fields: attachFingerprintFields({ ...params, envelope: mutation })
  })
  return { ...params, envelope: mutation }
}

function createIntentParams() {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'codex' }
  return { envelope: envelope('agentSession.create', fields, null), ...fields }
}

let codex: CodexScript
let root: string
let dispatcher: RpcDispatcher
let bootEnvironmentReads: number
let codexOverrideReads: number
let configuredCodexProfile: string
let shellEnvironmentPolicy: NativeChatShellEnvironmentPolicy

async function call(method: string, params: unknown): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  const request: RpcRequest = { id: `req-${operations}`, authToken: 'token', method, params }
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), CLIENT)
  const first = replies[0]
  if (!first) {
    throw new Error(`no reply for ${method}`)
  }
  return first
}

async function ok<T>(method: string, params: unknown): Promise<T> {
  const response = await call(method, params)
  expect(response, `${method} failed: ${JSON.stringify(response)}`).toMatchObject({ ok: true })
  const result = (response as { result: { ok: boolean; value?: T; refusal?: unknown } }).result
  expect(result, `${method} refused: ${JSON.stringify(result.refusal)}`).toMatchObject({ ok: true })
  return result.value as T
}

/** Flush provider writes; real clients wait for their subscription frames. */
const drainStreamedEvents = (): Promise<void> =>
  getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION) ?? Promise.resolve()

function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

beforeEach(async () => {
  operations = 0
  root = await mkdtemp(join(tmpdir(), 'orca-structured-integration-'))
  codex = fakeCodex()
  bootEnvironmentReads = 0
  codexOverrideReads = 0
  configuredCodexProfile = 'configured'
  shellEnvironmentPolicy = { inheritAll: true, names: [] }
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    resolveStructuredAgentSessionLocalWorkspacePath: async () => `/repos/${WORKSPACE}`,
    getClientSettings: () => ({ nativeChatProviders: { claude: true, codex: true } }),
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    structuredAgentSessionLaunchSeedOptions: () => undefined,
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return { ...resolved, options: { model: 'gpt-live' } }
    },
    publishStructuredAgentSessionTab: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        logger: createStructuredAgentSessionLogger(),
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
        resolveCodexCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
        runCodexCatalogSession: scriptedCodexCatalogSession,
        resolveAgentAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/home/dev/.codex' }),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
        resolveEnvironment: async () => {
          bootEnvironmentReads += 1
          return {
            PATH: '/shell/bin:/usr/bin',
            EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
            CODEX_HOME: '/shell/home'
          }
        },
        resolveShellEnvironmentPolicy: () => shellEnvironmentPolicy,
        resolveAgentLaunchEnv: (agent): Record<string, string> => {
          if (agent !== 'codex') {
            return {}
          }
          codexOverrideReads += 1
          return { CODEX_PROFILE: configuredCodexProfile }
        },
        ...scriptedCodexTransport(codex.openConnection)
      }).then(() => undefined),
    registerOwnedSubscriptionCleanup: vi.fn((_id: string, dispose: () => void) => ({
      releaseIfCurrent: dispose
    }))
  }
  dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
})

afterEach(async () => {
  await journals.closeAll()
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured codex session over agentSession.*', () => {
  it('joins final deferred writes before runtime teardown completes', async () => {
    await ok<{ fence: number }>('agentSession.create', createIntentParams())
    codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'item-final', text: '' }
    })
    await drainStreamedEvents()

    codex.notify('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-final',
      delta: 'Final text before shutdown.'
    })
    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const appendEntered = Promise.withResolvers<void>()
    const appendGate = Promise.withResolvers<void>()
    const originalAppend = journal.appendItem.bind(journal)
    vi.spyOn(journal, 'appendItem').mockImplementationOnce(async (...args) => {
      appendEntered.resolve()
      await appendGate.promise
      return originalAppend(...args)
    })

    let stopped = false
    const stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await appendEntered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const waitedForFinalAppend = !stopped
    appendGate.resolve()
    await stopping

    expect(waitedForFinalAppend).toBe(true)
    const reopened = await journals.open({
      identity: JOURNAL_IDENTITY,
      stateDirectory: root
    })
    expect(reopened.snapshot().items.map(textOf)).toContain('Final text before shutdown.')
    expect(
      reopened
        .snapshot()
        .items.some(
          (item) => item.body?.kind === 'status' && item.body.turnLifecycle?.state === 'running'
        )
    ).toBe(false)
  })
})
