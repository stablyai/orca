// Structured ACP session over `agentSession.*` with a scripted stdio child.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AcpJsonRpcConnection,
  AcpJsonRpcConnectionHandlers,
  openAcpJsonRpcConnection
} from '../acp/acp-jsonrpc-connection'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const SESSION = 'session-acp-1'
const WORKSPACE = 'workspace-1'
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

type FakeConnection = Omit<AcpJsonRpcConnection, 'closed'> & {
  closed: boolean
  handlers: AcpJsonRpcConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown }[]
  launch: Parameters<typeof openAcpJsonRpcConnection>[0]
}

function fakeAcp(script?: {
  initialize?: AcpJsonRpcConnection['initialize']
  sessionId?: string
  configOptions?: unknown[]
}): {
  connections: FakeConnection[]
  openConnection: typeof openAcpJsonRpcConnection
  live: () => FakeConnection
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      pid: 4242,
      closed: false,
      initialize: script?.initialize ?? {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { promptCapabilities: { image: true } }
      },
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'authenticate') {
          return {}
        }
        if (method === 'session/new' || method === 'session/load') {
          return {
            sessionId: script?.sessionId ?? 'acp-sess-1',
            configOptions: script?.configOptions ?? [
              {
                id: 'model',
                category: 'model',
                currentValue: 'grok-4.6',
                options: [{ value: 'grok-4.6', name: 'Grok 4.6' }]
              },
              {
                id: 'reasoning_effort',
                category: 'thought_level',
                currentValue: 'high',
                options: [
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra high' }
                ]
              }
            ]
          }
        }
        if (method === 'session/prompt') {
          connection.handlers.onNotification?.('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello from ACP.' }
            }
          })
          connection.handlers.onNotification?.('vendor/unknown', { ignored: true })
          return { stopReason: 'end_turn' }
        }
        if (method === 'session/set_config_option') {
          return {
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'grok-4.6',
                options: [{ value: 'grok-4.6', name: 'Grok 4.6' }]
              },
              {
                id: 'reasoning_effort',
                category: 'thought_level',
                currentValue: (params as { value?: string }).value ?? 'high',
                options: [
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra high' }
                ]
              }
            ]
          }
        }
        return {}
      },
      notify: (method, params) => {
        connection.calls.push({ method, params })
      },
      respond: (id, result) => {
        connection.replies.push({ id, result })
      },
      respondError: () => undefined,
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openAcpJsonRpcConnection
  return {
    connections,
    openConnection,
    live: () => {
      const connection = connections.at(-1)
      if (!connection) {
        throw new Error('no ACP child has been opened')
      }
      return connection
    }
  }
}

let operations = 0

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

function createIntentParams(agent: 'grok' | 'cursor' | 'claude') {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent }
  return { envelope: envelope('agentSession.create', fields, null), ...fields }
}

function attachResolved(agent: 'grok' | 'cursor' | 'claude') {
  return {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: agent,
    agent,
    accountHome:
      agent === 'grok'
        ? { variable: 'GROK_HOME' as const, path: '/home/dev/.grok' }
        : agent === 'cursor'
          ? { variable: 'CURSOR_CONFIG_DIR' as const, path: '/home/dev/.cursor' }
          : { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude' },
    runtimeKind: 'native' as const
  }
}

let acp: ReturnType<typeof fakeAcp>
let root: string
let dispatcher: RpcDispatcher

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

async function subscribe(requestId: string): Promise<AgentSessionSubscribeEvent[]> {
  const frames: AgentSessionSubscribeEvent[] = []
  await dispatcher.dispatchStreaming(
    {
      id: requestId,
      authToken: 'token',
      method: 'agentSession.subscribe',
      params: { sessionId: SESSION }
    },
    (raw) => {
      const response = JSON.parse(raw) as { ok: boolean; result?: AgentSessionSubscribeEvent }
      if (response.ok && response.result) {
        frames.push(response.result)
      }
    },
    CLIENT
  )
  return frames
}

function drainStreamedEvents(): Promise<void> {
  return getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION) ?? Promise.resolve()
}

function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const published =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.page.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const item of published) {
      items.set(item.itemId, item)
    }
  }
  return [...items.values()]
}

function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

beforeEach(async () => {
  operations = 0
  root = await mkdtemp(join(tmpdir(), 'orca-acp-integration-'))
  acp = fakeAcp()
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async (params: {
      agent: 'grok' | 'cursor' | 'claude'
    }) => attachResolved(params.agent),
    publishStructuredAgentSessionTab: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
        resolveEnvironment: async () => ({ PATH: '/bin' }),
        openAcpConnection: acp.openConnection,
        readProcessStartTime: async () => 1_700_000_000_000
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
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured ACP session over agentSession.*', () => {
  it('creates, sends, streams, sets effort, answers permission, and cancels', async () => {
    const created = await ok<{ fence: number; page: { items: unknown[] } }>(
      'agentSession.create',
      createIntentParams('grok')
    )
    expect(created.page.items).toEqual([])
    expect(acp.live().launch.cwd).toBe(`/repos/${WORKSPACE}`)
    expect(acp.live().launch.env).toMatchObject({ GROK_HOME: '/home/dev/.grok' })
    expect(acp.live().calls[0]).toMatchObject({
      method: 'session/new',
      params: { cwd: `/repos/${WORKSPACE}`, mcpServers: [] }
    })

    const stream = await subscribe('sub-acp')
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: {
        current: { model: 'grok-4.6', effort: 'high' }
      }
    })
    await ok('agentSession.setOption', {
      envelope: envelope(
        'agentSession.setOption',
        { key: 'effort', value: 'xhigh' },
        created.fence
      ),
      key: 'effort',
      value: 'xhigh'
    })
    expect(acp.live().calls.some((call) => call.method === 'session/set_config_option')).toBe(true)

    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
    const sent = await ok<{ submission: { dispatchState: string } }>('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    })
    expect(sent.submission.dispatchState).toBe('accepted')
    await drainStreamedEvents()
    expect(itemsOf(stream).map(textOf).filter(Boolean)).toEqual(['hi', 'Hello from ACP.'])

    acp.live().handlers.onServerRequest?.({
      id: 11,
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'Read package.json', toolCallId: 'tool-read' },
        options: [{ optionId: 'allow-once', name: 'Allow once' }]
      }
    })
    await drainStreamedEvents()
    const approval = itemsOf(stream).find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({ title: 'Read package.json' })
    await ok('agentSession.respondToApproval', {
      envelope: envelope(
        'agentSession.respondTo:approval',
        {
          itemId: approval?.itemId,
          expectedRevision: approval?.revision,
          optionId: 'allow-once'
        },
        created.fence
      ),
      itemId: approval?.itemId,
      expectedRevision: approval?.revision,
      optionId: 'allow-once'
    })
    expect(acp.live().replies).toEqual([
      { id: 11, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }
    ])

    const cancelled = await ok<{ cancelled: boolean }>('agentSession.cancel', {
      envelope: envelope('agentSession.cancel', { turnId: 'acp-turn-1' }, created.fence),
      turnId: 'acp-turn-1'
    })
    expect(cancelled.cancelled).toBe(true)
    expect(acp.live().calls.at(-1)).toMatchObject({ method: 'session/cancel' })
  })

  it('authenticates Cursor with cursor_login before session/new', async () => {
    acp = fakeAcp({
      initialize: { authMethods: [{ id: 'cursor_login' }] },
      sessionId: 'cursor-sess',
      configOptions: []
    })
    await stopStructuredAgentSessionRuntime()
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
      resolveStructuredAgentSessionCreateIntent: async (params: { agent: 'cursor' }) =>
        attachResolved(params.agent),
      publishStructuredAgentSessionTab: () => {},
      ensureStructuredAgentSessionHost: () =>
        ensureStructuredAgentSessionHost({
          stateDirectory: root,
          hostId: 'local',
          claimKeyId: 'key-1',
          resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
          resolveEnvironment: async () => ({ PATH: '/bin' }),
          openAcpConnection: acp.openConnection,
          readProcessStartTime: async () => 1_700_000_000_000
        }).then(() => undefined),
      registerOwnedSubscriptionCleanup: vi.fn((_id: string, dispose: () => void) => ({
        releaseIfCurrent: dispose
      }))
    }
    dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: STRUCTURED_AGENT_SESSION_METHODS
    })
    await ok('agentSession.create', createIntentParams('cursor'))
    expect(acp.live().calls.map((call) => call.method)).toEqual(['authenticate', 'session/new'])
    expect(acp.live().calls[0]?.params).toEqual({ methodId: 'cursor_login' })
  })
})
