import { describe, expect, it } from 'vitest'

import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpJsonRpcConnection, AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

function fakeConnection(script: {
  initialize?: AcpJsonRpcConnection['initialize']
  onRequest?: (method: string, params?: Record<string, unknown>) => unknown
}): AcpJsonRpcConnection & {
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown }[]
  errors: { id: number | string; code: number }[]
} {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const replies: { id: number | string; result?: unknown }[] = []
  const errors: { id: number | string; code: number }[] = []
  return {
    pid: 99,
    closed: false,
    initialize: script.initialize ?? { protocolVersion: 1, authMethods: [] },
    calls,
    replies,
    errors,
    request: async (method, params) => {
      calls.push({ method, params })
      return script.onRequest?.(method, params)
    },
    notify: (method, params) => {
      calls.push({ method, params })
    },
    respond: (id, result) => {
      replies.push({ id, result })
    },
    respondError: (id, code) => {
      errors.push({ id, code })
    },
    close: async () => true
  }
}

const localLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'ws-1',
  workspaceKind: 'git-worktree' as const
} satisfies AgentSessionExecutionLocation

describe('AcpStructuredSessionAdapter', () => {
  it('acquires a Grok ACP session and dispatches a user prompt', async () => {
    const items: { body: AgentJournalItemBody }[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => {
        items.push({ body })
      },
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    let handlers: AcpJsonRpcConnectionHandlers = {}
    const connection = fakeConnection({
      onRequest: (method) => {
        if (method === 'session/new') {
          return {
            sessionId: 'grok-sess',
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
          handlers.onNotification?.('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello ' }
            }
          })
          handlers.onNotification?.('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'from grok' }
            }
          })
          handlers.onNotification?.('session/unknown_vendor', { ping: true })
          return { stopReason: 'end_turn' }
        }
        return {}
      }
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async (_launch, nextHandlers) => {
        handlers = nextHandlers ?? {}
        return connection
      },
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1_700_000_000_000
    })
    expect(adapter.supportsCreate?.(localLocation, 'grok')).toBe(true)
    const acquired = await adapter.acquire({
      identity: {
        sessionId: 'orca-session-1',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-1',
      events: sink
    })
    expect(acquired.link.handle).toEqual({ provider: 'grok', sessionId: 'grok-sess' })
    expect(connection.calls.some((call) => call.method === 'authenticate')).toBe(false)
    const dispatched = await adapter.dispatch({
      sessionId: 'orca-session-1',
      clientMessageId: 'msg-1',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
    })
    expect(dispatched.state).toBe('accepted')
    expect(
      items.findLast((item) => item.body.kind === 'message' && item.body.role === 'assistant')?.body
    ).toMatchObject({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hello from grok' }]
    })
    const options = await adapter.readOptions({ sessionId: 'orca-session-1', fence: 1 })
    expect(options.current).toMatchObject({ model: 'grok-4.6', effort: 'high' })
    expect(options.models[0]?.efforts.map((effort) => effort.value)).toEqual(['high', 'xhigh'])
    await adapter.setOption({
      sessionId: 'orca-session-1',
      key: 'effort',
      value: 'xhigh',
      fence: 1
    })
    expect(connection.calls.some((call) => call.method === 'session/set_config_option')).toBe(true)
    const cancelled = await adapter.cancelTurn({
      sessionId: 'orca-session-1',
      turnId: 'acp-turn-1',
      fence: 1
    })
    expect(cancelled).toEqual({ cancelled: true })
    expect(connection.calls.at(-1)).toMatchObject({ method: 'session/cancel' })
  })

  it('authenticates Cursor with cursor_login and answers a permission card', async () => {
    const items: { body: AgentJournalItemBody }[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => {
        items.push({ body })
      },
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    let handlers: AcpJsonRpcConnectionHandlers = {}
    const connection = fakeConnection({
      initialize: { authMethods: [{ id: 'cursor_login' }] },
      onRequest: (method) => {
        if (method === 'session/new') {
          return {
            sessionId: 'cursor-sess',
            configOptions: [
              {
                id: 'mode',
                category: 'mode',
                currentValue: 'agent',
                options: [
                  { value: 'agent', name: 'Agent' },
                  { value: 'plan', name: 'Plan' },
                  { value: 'ask', name: 'Ask' }
                ]
              }
            ]
          }
        }
        return {}
      }
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async (_launch, nextHandlers) => {
        handlers = nextHandlers ?? {}
        return connection
      },
      resolveLaunch: async () => ({ command: 'agent', args: ['acp'], cwd: '/repo' }),
      readProcessStartTime: async () => 1_700_000_000_000
    })
    await adapter.acquire({
      identity: {
        sessionId: 'orca-cursor',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'cursor',
        providerHandle: { kind: 'opaque', agent: 'cursor', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-2',
      events: sink
    })
    expect(connection.calls[0]).toMatchObject({
      method: 'authenticate',
      params: { methodId: 'cursor_login' }
    })
    handlers.onServerRequest?.({
      id: 7,
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'Read file', toolCallId: 'tool-1' },
        options: [{ optionId: 'allow-once', name: 'Allow once' }]
      }
    })
    expect(items.some((item) => item.body.kind === 'approval')).toBe(true)
    await adapter.answerPrompt({
      sessionId: 'orca-cursor',
      itemId: 'tool-1',
      kind: 'approval',
      optionId: 'allow-once',
      fence: 1
    })
    expect(connection.replies).toEqual([
      { id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }
    ])
    handlers.onServerRequest?.({
      id: 8,
      method: 'cursor/ask_question',
      params: {
        questions: [
          {
            id: 'q1',
            prompt: 'Which file?',
            options: [{ id: 'a', label: 'A' }]
          }
        ]
      }
    })
    await adapter.answerPrompt({
      sessionId: 'orca-cursor',
      itemId: 'q1',
      kind: 'question',
      optionId: 'a',
      fence: 1
    })
    expect(connection.replies.at(-1)).toMatchObject({
      id: 8,
      result: { answers: [{ id: 'q1', optionId: 'a' }] }
    })
  })

  it('rejects an image prompt when the agent did not advertise image capability', async () => {
    const connection = fakeConnection({
      onRequest: (method) => (method === 'session/new' ? { sessionId: 'claude-sess' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp'],
        cwd: '/repo'
      }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'orca-claude',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-3'
    })
    const dispatched = await adapter.dispatch({
      sessionId: 'orca-claude',
      clientMessageId: 'msg-img',
      fence: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/shot.png' }]
      }
    })
    expect(dispatched).toMatchObject({
      state: 'rejected',
      reason: 'ACP session does not accept images'
    })
  })
})
