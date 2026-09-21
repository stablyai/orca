import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'

function identityFor(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

type Route = (params: Record<string, unknown> | undefined) => unknown

// `closed` is readonly on the real connection; the fake flips it so a test can
// kill the child at a chosen moment.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number; message?: string }[]
  closeCount: number
}

/** Stands in for a live `codex app-server`: every RPC is answered from `routes`,
 *  and the test drives Codex's own traffic through `handlers`. */
function fakeCodex(routes: Record<string, Route> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        const route = routes[method]
        return route ? route(params) : {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code, message) => connection.replies.push({ id, code, message }),
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  routes['thread/start'] ??= () => ({
    thread: { id: THREAD_ID, path: '/rollouts/abc.jsonl' },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  routes['thread/resume'] ??= (params) => ({
    thread: { id: (params as { threadId: string }).threadId },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  return { connections, openConnection, routes }
}

function adapterFor(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = [],
  processControl: Partial<
    Pick<CodexStructuredSessionAdapterDeps, 'captureTurnProcesses' | 'terminateTurnProcesses'>
  > = {}
): CodexStructuredSessionAdapter {
  let acquisitionGeneration = 0
  return new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    captureTurnProcesses: async () => ({ platform: 'win32', identities: new Map() }),
    terminateTurnProcesses: async () => true,
    now: () => 1_700_000_000_500,
    mintAcquisitionGeneration: () => `generation-${++acquisitionGeneration}`,
    ...processControl
  })
}

async function acquired(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = []
): Promise<CodexStructuredSessionAdapter> {
  const adapter = adapterFor(codex, launch, events)
  await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}

describe('CodexStructuredSessionAdapter lifecycle', () => {
  it('keeps sessions isolated and closes each child once', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    await adapter.acquire({ identity: identityFor('session-1'), fence: 1, spawnToken: 'spawn-a' })
    await adapter.acquire({ identity: identityFor('session-2'), fence: 1, spawnToken: 'spawn-b' })

    codex.connections[0].handlers.onServerRequest?.({
      id: 21,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'codex-item-1', threadId: THREAD_ID, turnId: 'turn-1' }
    })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-2',
        itemId: 'codex-item-1',
        kind: 'approval',
        optionId: 'accept',
        fence: 1
      })
    ).rejects.toThrow('no longer waiting on')

    await adapter.closeAll()
    expect(codex.connections.map((connection) => connection.closeCount)).toEqual([1, 1])
    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 1 })
    ).rejects.toThrow('no live codex app-server for session session-1')
  })

  it('retains ownership until a child exit is proven and reports it once', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)

    const connection = codex.connections[0]
    connection.close = async () => {
      connection.closeCount += 1
      return false
    }
    connection.handlers.onExit?.(new Error('codex app-server connection ended'))

    expect(events.at(-1)).toEqual({
      type: 'ended',
      sessionId: 'session-1',
      reason: 'codex app-server connection ended',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1'
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live codex app-server')
    expect(await adapter.historyFilePath({ identity: identityFor('session-1') })).toBe(
      '/rollouts/abc.jsonl'
    )
    await expect(adapter.closeSession('session-1')).resolves.toBe(false)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  })

  it('keeps the live session when a child it already replaced dies', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)
    await adapter.acquire({ identity: identityFor('session-1'), fence: 8, spawnToken: 'spawn-10' })
    const endedBeforeStaleExit = events.filter((event) => event.type === 'ended').length

    codex.connections[0].handlers.onExit?.(new Error('the superseded child died'))

    expect(events.filter((event) => event.type === 'ended')).toHaveLength(endedBeforeStaleExit)
    expect(await adapter.historyFilePath({ identity: identityFor('session-1') })).toBe(
      '/rollouts/abc.jsonl'
    )
  })

  it('ignores Codex traffic that arrives after the session is gone', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)
    const connection = codex.connections[0]

    await adapter.closeSession('session-1')
    connection.handlers.onNotification?.('item/agentMessage/delta', { delta: 'x' })
    connection.handlers.onServerRequest?.({
      id: 31,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'codex-item-9', threadId: THREAD_ID }
    })

    expect(connection.replies).toEqual([])
  })

  it('flushes the final coalesced text before a graceful close', async () => {
    const codex = fakeCodex()
    const bodies: AgentJournalMessageItem[] = []
    const tombstones: unknown[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => {
        if (body.kind === 'message') {
          bodies.push(body)
        }
      },
      appendTombstone: (identity) => {
        tombstones.push(identity)
      },
      publish: () => {}
    }
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const notify = codex.connections[0]!.handlers.onNotification
    notify?.('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-1' } })
    notify?.('item/started', {
      threadId: THREAD_ID,
      item: { type: 'agentMessage', id: 'item-1', text: '' }
    })
    notify?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      itemId: 'item-1',
      delta: 'last words'
    })

    await adapter.closeSession('session-1')

    expect(bodies.at(-1)?.blocks).toEqual([{ type: 'text', text: 'last words' }])
    expect(tombstones).toContainEqual({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    })
  })
})
