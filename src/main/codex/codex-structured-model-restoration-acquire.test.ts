import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type { CodexStructuredLaunch } from './codex-structured-session-state'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

const THREAD_ID = 'thread-restored'
const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'continue' }]
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

type Route = (params: Record<string, unknown> | undefined) => unknown
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  closeCount: number
}

function fakeCodex(routes: Record<string, Route> = {}) {
  const connections: FakeConnection[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        return routes[method]?.(params) ?? {}
      },
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
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
    thread: { id: THREAD_ID },
    model: 'listed-default',
    reasoningEffort: 'medium'
  })
  routes['thread/resume'] ??= () => ({
    thread: { id: THREAD_ID },
    model: 'listed-default',
    reasoningEffort: 'medium'
  })
  routes['model/list'] ??= () => ({
    data: [
      {
        model: 'listed-default',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
        defaultReasoningEffort: 'medium'
      }
    ],
    nextCursor: null
  })
  return { connections, openConnection, routes }
}

function adapterFor(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  onEvent = vi.fn(),
  readProcessStartTime: (pid: number) => Promise<number | null> = async () => 1_700_000_000_000
): CodexStructuredSessionAdapter {
  return new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null,
      ...launch
    }),
    openConnection: codex.openConnection,
    readProcessStartTime,
    captureTurnProcesses: async () => ({ platform: 'win32', identities: new Map() }),
    terminateTurnProcesses: async () => true,
    mintAcquisitionGeneration: () => 'generation-restored',
    onEvent
  })
}

function recordingSink(): {
  sink: StructuredAgentSessionEventSink
  items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]
  publish: ReturnType<typeof vi.fn>
} {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const publish = vi.fn()
  return {
    items,
    publish,
    sink: {
      appendItem: (itemIdentity, body) => items.push({ identity: itemIdentity, body }),
      appendTombstone: vi.fn(),
      publish
    }
  }
}

async function dispatch(adapter: CodexStructuredSessionAdapter, clientMessageId: string) {
  return adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId,
    body: USER_MESSAGE,
    fence: 7
  })
}

describe('Codex structured model restoration acquisition', () => {
  it.each([
    { name: 'thread/start', launch: {} },
    { name: 'thread/resume', launch: { resumeThreadId: THREAD_ID } }
  ])('acquires and dispatches twice after refusing a stale pick on $name', async ({ launch }) => {
    const onEvent = vi.fn()
    const codex = fakeCodex()
    let turn = 0
    codex.routes['turn/start'] = () => {
      turn += 1
      codex.connections[0].handlers.onNotification?.('item/completed', {
        threadId: THREAD_ID,
        turnId: `turn-${turn}`,
        item: { id: `message-${turn}`, type: 'agentMessage', text: 'done' }
      })
      codex.connections[0].handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: `turn-${turn}`, status: 'completed', items: [] }
      })
      return { turn: { id: `turn-${turn}` } }
    }
    const adapter = adapterFor(codex, launch, onEvent)

    await expect(
      adapter.acquire({
        identity: identity(),
        fence: 7,
        spawnToken: 'spawn-1',
        options: { model: 'retired-id', effort: 'high', approvalPolicy: 'never' }
      })
    ).resolves.toMatchObject({ link: { handle: { threadId: THREAD_ID } } })
    await expect(dispatch(adapter, 'client-1')).resolves.toMatchObject({ state: 'accepted' })
    await expect(dispatch(adapter, 'client-2')).resolves.toMatchObject({ state: 'accepted' })

    const turns = codex.connections[0].calls.filter((call) => call.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect(turns.map((call) => call.params)).toEqual([
      expect.objectContaining({
        model: 'listed-default',
        effort: 'medium',
        approvalPolicy: 'never'
      }),
      expect.objectContaining({
        model: 'listed-default',
        effort: 'medium',
        approvalPolicy: 'never'
      })
    ])
    expect(onEvent.mock.calls.some(([event]) => event.method === 'turn/completed')).toBe(true)
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('overrides an unlisted resumed model before the first turn', async () => {
    const codex = fakeCodex({
      'thread/resume': () => ({
        thread: { id: THREAD_ID },
        model: 'retired-resume',
        reasoningEffort: 'high'
      }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID })

    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    await dispatch(adapter, 'client-1')

    expect(codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params).toEqual(
      expect.objectContaining({ model: 'listed-default', effort: 'medium' })
    )
  })

  it('shows the automatic model substitution in the conversation', async () => {
    const codex = fakeCodex()
    const journal = recordingSink()
    const adapter = adapterFor(codex)

    await adapter.acquire({
      identity: identity(),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'retired-id' },
      events: journal.sink
    })

    expect(journal.items).toContainEqual({
      identity: {
        provider: 'orca',
        clientMessageId: 'codex-model-restoration:generation-restored'
      },
      body: {
        kind: 'status',
        text: expect.stringMatching(/retired-id.*provider-listed default "listed-default"/),
        tone: 'warning'
      }
    })
    expect(journal.publish).toHaveBeenCalled()
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'listed-default' }
    })
  })

  it('preserves admitted restored picks and other turn options', async () => {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'account-private',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
          },
          { model: 'listed-default', isDefault: true }
        ],
        nextCursor: null
      }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const journal = recordingSink()
    const adapter = adapterFor(codex)

    await adapter.acquire({
      identity: identity(),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'account-private', effort: 'high', approvalPolicy: 'never' },
      events: journal.sink
    })
    await dispatch(adapter, 'client-1')

    expect(codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params).toEqual(
      expect.objectContaining({ model: 'account-private', effort: 'high', approvalPolicy: 'never' })
    )
    expect(journal.items).toEqual([])
  })

  it.each([
    {
      name: 'unsupported method',
      route: () => {
        throw new CodexAppServerRequestError('model/list', -32601, 'method not found')
      }
    },
    {
      name: 'timeout',
      route: () => {
        throw new Error('model/list timed out')
      }
    },
    { name: 'empty list', route: () => ({ data: [], nextCursor: null }) }
  ])('does not fail adapter acquisition for $name', async ({ route }) => {
    const codex = fakeCodex({
      'model/list': route,
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = adapterFor(codex)

    await expect(
      adapter.acquire({
        identity: identity(),
        fence: 7,
        spawnToken: 'spawn-1',
        options: { model: 'unknown-restored', effort: 'high' }
      })
    ).resolves.toBeDefined()
    await dispatch(adapter, 'client-1')

    expect(codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params).toEqual(
      expect.objectContaining({ model: 'unknown-restored', effort: 'high' })
    )
    expect(codex.connections[0].closeCount).toBe(0)
  })

  it('does not publish a superseded acquisition after catalog enumeration', async () => {
    const catalogStarted = Promise.withResolvers<void>()
    const catalog = Promise.withResolvers<unknown>()
    const codex = fakeCodex({
      'model/list': () => {
        catalogStarted.resolve()
        return catalog.promise
      }
    })
    const readProcessStartTime = vi.fn(async () => 1_700_000_000_000)
    const adapter = adapterFor(codex, {}, vi.fn(), readProcessStartTime)
    const acquiring = adapter.acquire({
      identity: identity(),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'retired-id' }
    })
    await catalogStarted.promise

    const closing = adapter.closeAll()
    catalog.resolve({
      data: [{ model: 'listed-default', isDefault: true }],
      nextCursor: null
    })

    await expect(acquiring).rejects.toThrow('superseded while being acquired')
    await closing
    await expect(dispatch(adapter, 'client-1')).rejects.toThrow('no live codex app-server')
    expect(codex.connections[0].calls.some((call) => call.method === 'turn/start')).toBe(false)
    expect(codex.connections[0].closeCount).toBe(2)
    expect(readProcessStartTime).not.toHaveBeenCalled()
  })

  it('does not treat an unlisted current model as membership evidence during acquisition', async () => {
    const codex = fakeCodex({
      'thread/resume': () => ({ thread: { id: THREAD_ID }, model: 'retired-id' }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = adapterFor(codex, { resumeThreadId: THREAD_ID })

    await adapter.acquire({
      identity: identity(),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'retired-id' }
    })
    await dispatch(adapter, 'client-1')

    expect(codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params).toEqual(
      expect.objectContaining({ model: 'listed-default' })
    )
  })
})
