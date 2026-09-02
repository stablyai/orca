// One structured Codex session driven end to end over `agentSession.*`.
//
// Nothing here is stubbed except the Codex child itself: the RPC dispatcher, the
// zod schemas, the capability gate, the durable record store, the journal, the
// lease, the Codex adapter, and the event-to-journal translation are all the ones
// that ship. The fake app-server answers the same JSON-RPC calls the real one
// does and pushes the same notifications and blocking requests back.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import type { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { journalDirectoryFor } from '../native-chat/agent-session-journal/journal-paths'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const SESSION = 'session-integration-1'
const THREAD = 'thread-integration'
const TURN = 'turn-1'
const WORKSPACE = 'workspace-1'
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

// ─── the fake `codex app-server` ────────────────────────────────────────────

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
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
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
  }) as typeof openCodexAppServerConnection
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

// ─── the RPC client ─────────────────────────────────────────────────────────

let operations = 0

/** `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. Real
 *  time, not a frozen constant: the runtime under test stamps the ledger with
 *  its own clock and refuses a future-dated id. */
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

/** Runs a one-shot method and returns its decoded reply. */
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

/** Asserts success and unwraps the host's `{ok:true, value}` mutation result. */
async function ok<T>(method: string, params: unknown): Promise<T> {
  const response = await call(method, params)
  expect(response, `${method} failed: ${JSON.stringify(response)}`).toMatchObject({ ok: true })
  const result = (response as { result: { ok: boolean; value?: T; refusal?: unknown } }).result
  expect(result, `${method} refused: ${JSON.stringify(result.refusal)}`).toMatchObject({ ok: true })
  return result.value as T
}

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
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
        resolveCodexCommand: () => '/usr/local/bin/codex',
        resolveEnvironment: async () => {
          bootEnvironmentReads += 1
          return {
            PATH: '/shell/bin:/usr/bin',
            EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
            CODEX_HOME: '/shell/home'
          }
        },
        resolveCodexOverrides: () => {
          codexOverrideReads += 1
          return { CODEX_PROFILE: configuredCodexProfile }
        },
        openCodexConnection: codex.openConnection,
        readProcessStartTime: async () => 1_700_000_000_000
      }).then(() => undefined),
    registerOwnedSubscriptionCleanup: vi.fn((_id: string, dispose: () => void) => {
      return {
        releaseIfCurrent: dispose
      }
    })
  }
  dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured codex session over agentSession.*', () => {
  it('replays a durable image send without dispatching it twice', async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    const path = '/tmp/orca-paste-image.png'
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'image-ref' as const, path }]
    }
    const params = {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    }

    await ok('agentSession.send', params)
    const replay = await call('agentSession.send', params)

    expect(replay).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
    expect(codex.live().calls.filter((entry) => entry.method === 'turn/start')).toHaveLength(1)
  })

  it('joins an acquired attach through journal bind before draining final rows', async () => {
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
      resolveCodexCommand: () => '/usr/local/bin/codex',
      openCodexConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const adapter = (host as unknown as { deps: { adapter: CodexStructuredSessionAdapter } }).deps
      .adapter
    const historyEntered = Promise.withResolvers<void>()
    const historyGate = Promise.withResolvers<void>()
    const originalHistoryFilePath = adapter.historyFilePath.bind(adapter)
    vi.spyOn(adapter, 'historyFilePath').mockImplementation(async (input) => {
      historyEntered.resolve()
      await historyGate.promise
      return originalHistoryFilePath(input)
    })

    const creating = ok<{ fence: number }>('agentSession.create', createIntentParams())
    await historyEntered.promise
    codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'item-bind-window', text: '' }
    })
    codex.notify('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-bind-window',
      delta: 'Buffered while the journal opens.'
    })

    let stopped = false
    const stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const waitedForJournalBind = !stopped
    historyGate.resolve()
    await creating
    await stopping
    expect(waitedForJournalBind).toBe(true)

    const identity = {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
    const reopened = await openAgentSessionJournal({
      identity,
      journalDir: journalDirectoryFor(root, identity)
    })
    expect(reopened.snapshot().items.map(textOf)).toContain('Buffered while the journal opens.')
    expect(
      reopened
        .snapshot()
        .items.some(
          (item) => item.body?.kind === 'status' && item.body.turnLifecycle?.state === 'running'
        )
    ).toBe(false)
  })
})
