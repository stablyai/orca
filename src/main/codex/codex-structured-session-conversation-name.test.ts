import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { codexConversationNameCapabilityCache } from './codex-conversation-name-capability'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'
const SESSION = 'session-1'

const identity: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: THREAD_ID }
}

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
}

/** A `codex app-server` that answers `thread/start` and `thread/resume` and lets
 *  a test push the notifications Codex would broadcast. */
function fakeCodex(threadName?: string): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (
    _launch: CodexAppServerLaunch,
    handlers: CodexAppServerConnectionHandlers = {}
  ) => {
    const connection: FakeConnection = {
      handlers,
      pid: 4321,
      closed: false,
      request: async () => ({
        thread: { id: THREAD_ID, ...(threadName ? { name: threadName } : {}) }
      }),
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        connection.closed = true
        return true
      }
    } as FakeConnection
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection }
}

async function acquired(codex: ReturnType<typeof fakeCodex>, resumeThreadId: string | null = null) {
  const onConversationName = vi.fn()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    onConversationName
  })
  await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-9' })
  return { adapter, onConversationName }
}

describe('Codex structured conversation name', () => {
  it('reports the name a resumed thread already carried', async () => {
    const { onConversationName } = await acquired(fakeCodex('Fix the lease probe'), THREAD_ID)

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('reports nothing for a thread the app-server has never named', async () => {
    const { onConversationName } = await acquired(fakeCodex())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it("reports a rename of this session's own thread", async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', {
      threadId: THREAD_ID,
      threadName: 'Fix the lease probe'
    })

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('reports a rename only once while the name is unchanged', async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)
    const rename = { threadId: THREAD_ID, threadName: 'Fix the lease probe' }

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', rename)
    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', rename)

    expect(onConversationName).toHaveBeenCalledOnce()
  })

  it('ignores a name-updated broadcast for another stored thread', async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', {
      threadId: 'some-other-thread',
      threadName: 'Someone else’s chat'
    })

    expect(onConversationName).not.toHaveBeenCalled()
  })
})

function namingProvider(
  options: {
    hang?: boolean
    decline?: boolean
    failClose?: boolean
    holdClose?: Promise<void>
    /** The user's own thread rejects the finished name. */
    failUserNameSet?: boolean
  } = {}
) {
  const connections: FakeConnection[] = []
  const launchCalls: CodexAppServerLaunch[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const index = connections.length
    const naming = index > 0
    const connection: FakeConnection = {
      handlers,
      pid: 4321 + index,
      closed: false,
      notify: vi.fn(),
      respond: vi.fn(),
      respondWithError: vi.fn(),
      request: vi.fn(async (method, params) => {
        if (method === 'config/read') {
          return { config: {} }
        }
        if (method === 'thread/name/set' && !naming && options.failUserNameSet) {
          throw new Error('name write refused')
        }
        if (method === 'thread/start') {
          return { thread: { id: naming ? 'naming' : THREAD_ID, ephemeral: naming } }
        }
        if (method === 'thread/read') {
          return { thread: { id: THREAD_ID } }
        }
        if (method === 'turn/start' && naming && !options.hang) {
          if (!options.decline) {
            handlers.onNotification?.('item/completed', {
              item: { type: 'agentMessage', text: '{"title":"Fix probe"}' }
            })
          }
          handlers.onNotification?.('turn/completed', {})
        }
        return { turn: { id: params?.threadId === THREAD_ID ? 'user-turn' : 'naming-turn' } }
      }),
      close: vi.fn(async () => {
        if (naming) {
          await options.holdClose
        }
        if (naming && options.failClose) {
          return false
        }
        connection.closed = true
        return true
      })
    }
    launchCalls.push(launch)
    connections.push(connection)
    handlers.onConnection?.(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection, launchCalls }
}

const userMessage = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix probe' }]
} as const
async function namingAdapter(provider: ReturnType<typeof namingProvider>, attempted = false) {
  const onConversationName = vi.fn()
  const markNamingAttempted = vi.fn()
  const onConversationNameCleared = vi.fn()
  const onEvent = vi.fn()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/folder',
      codexHome: '/account',
      env: { CUSTOM: 'value' },
      resumeThreadId: null
    }),
    openConnection: provider.openConnection,
    readProcessStartTime: async () => 1000,
    onConversationName,
    markNamingAttempted,
    onConversationNameCleared,
    readNamingAttempted: () => attempted,
    onEvent
  })
  await adapter.acquire({ identity, fence: 7, spawnToken: 'user-spawn' })
  const dispatch = async (body: unknown = userMessage) => {
    await adapter.dispatch({
      sessionId: SESSION,
      fence: 7,
      clientMessageId: 'message',
      body: body as never
    })
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve()
    }
  }
  return {
    adapter,
    dispatch,
    onConversationName,
    onConversationNameCleared,
    markNamingAttempted,
    onEvent
  }
}

describe('Codex naming process isolation through the adapter', () => {
  // The capability cache is a module singleton shared by every test here.
  beforeEach(() => codexConversationNameCapabilityCache.clear())

  it('marks the attempt durably when the name write rejects after a billed turn', async () => {
    // The rejection unwinds past the publish path, so without an explicit
    // settle nothing durable is written and the next acquisition pays again.
    const provider = namingProvider({ failUserNameSet: true })
    const f = await namingAdapter(provider)

    await f.dispatch()

    expect(f.markNamingAttempted).toHaveBeenCalledWith(SESSION)
    expect(f.onConversationName).not.toHaveBeenCalled()
    await f.adapter.closeAll()
  })

  it.each(['A newer manual name', null])(
    'preserves a newer provider publication during naming cleanup: %s',
    async (newerName) => {
      let release = (): void => {}
      const holdClose = new Promise<void>((resolve) => {
        release = resolve
      })
      const provider = namingProvider({ holdClose })
      const f = await namingAdapter(provider)
      await f.dispatch()
      expect(provider.connections[1]!.close).toHaveBeenCalled()
      provider.connections[0]!.handlers.onNotification?.('thread/name/updated', {
        threadId: THREAD_ID,
        threadName: 'Fix probe'
      })
      provider.connections[0]!.handlers.onNotification?.('thread/name/updated', {
        threadId: THREAD_ID,
        threadName: newerName
      })
      f.onConversationName.mockClear()
      release()
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve()
      }
      expect(f.onConversationName).not.toHaveBeenCalled()
      expect(f.onConversationNameCleared).toHaveBeenCalledTimes(newerName === null ? 1 : 0)
      await f.adapter.closeAll()
    }
  )

  it('starts a separate process once and delivers only the final name to the session', async () => {
    const provider = namingProvider()
    const f = await namingAdapter(provider)
    await f.dispatch()
    expect(provider.connections).toHaveLength(2)
    expect(f.onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix probe')
    expect(f.markNamingAttempted).toHaveBeenCalledOnce()
    expect(provider.connections[1]!.closed).toBe(true)
    expect(provider.connections[0]!.request).not.toHaveBeenCalledWith(
      'config/read',
      expect.anything(),
      expect.anything()
    )
    expect(JSON.stringify(f.onEvent.mock.calls)).not.toContain('Fix probe')
    expect(provider.launchCalls[1]).toMatchObject({
      cwd: '/folder',
      env: { CODEX_HOME: '/account', CUSTOM: 'value' }
    })
    await f.dispatch()
    expect(provider.connections).toHaveLength(2)
    await f.adapter.closeAll()
  })

  it('preserves user subagent and unattributed frames throughout naming', async () => {
    const provider = namingProvider({ hang: true })
    const f = await namingAdapter(provider)
    await f.dispatch()
    f.onEvent.mockClear()
    provider.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: 'subagent',
      item: { type: 'agentMessage', text: 'Visible subagent' }
    })
    provider.connections[0]!.handlers.onUnhandledFrame?.('unknown', {
      message: 'Visible diagnostic'
    })
    provider.connections[1]!.handlers.onUnhandledFrame?.('unknown', {
      message: 'Private naming diagnostic'
    })
    provider.connections[1]!.handlers.onNotification?.('item/completed', {
      item: { type: 'agentMessage', text: 'Private naming answer' }
    })
    const events = JSON.stringify(f.onEvent.mock.calls)
    expect(events).toContain('Visible subagent')
    expect(events).toContain('Visible diagnostic')
    expect(events).not.toContain('Private naming')
    await f.adapter.closeAll()
  })

  it('closes the session and retries a naming child whose exit cannot be proven', async () => {
    // The naming child is cosmetic: gating the close on its exit proof made
    // acquisition throw and left the user with an unusable chat.
    const provider = namingProvider({ hang: true, failClose: true })
    const f = await namingAdapter(provider)
    await f.dispatch()
    await expect(f.adapter.closeSession(SESSION)).resolves.toBe(true)
    const close = vi.mocked(provider.connections[1]!.close)
    expect(close).toHaveBeenCalled()
    // Ownership moved to the orphan registry, which shutdown still drains.
    close.mockResolvedValue(true)
    await f.adapter.closeAll()
    expect(close.mock.calls.length).toBeGreaterThan(1)
  })

  it('waits for text after an image-only first message', async () => {
    const provider = namingProvider()
    const f = await namingAdapter(provider)
    await f.dispatch({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image', path: '/image.png' }]
    })
    expect(provider.connections).toHaveLength(1)
    await f.dispatch()
    expect(f.onConversationName).toHaveBeenCalledOnce()
    await f.adapter.closeAll()
  })

  it('honors the durable attempt marker before launching a naming child', async () => {
    const provider = namingProvider()
    const f = await namingAdapter(provider, true)
    await f.dispatch()
    expect(provider.connections).toHaveLength(1)
    await f.adapter.closeAll()
  })

  it('durably records a genuine decline without relabeling the session', async () => {
    const provider = namingProvider({ decline: true })
    const f = await namingAdapter(provider)
    await f.dispatch()
    expect(f.markNamingAttempted).toHaveBeenCalledOnce()
    expect(f.onConversationName).not.toHaveBeenCalled()
    await f.adapter.closeAll()
  })
})
