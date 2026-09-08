import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'
const LIST = 'thread/backgroundTerminals/list'
const CLEAN = 'thread/backgroundTerminals/clean'
const TERMINATE = 'thread/backgroundTerminals/terminate'

type Route = (params: Record<string, unknown> | undefined) => unknown
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

function fakeCodex(): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const routes: Record<string, Route> = {
    'thread/resume': () => ({ thread: { id: THREAD_ID } }),
    [LIST]: () => ({
      data: [{ itemId: 'item-1', processId: 'proc-1', command: 'sleep 180', osPid: 14040 }]
    })
  }
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        return routes[method]?.(params) ?? {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection, routes }
}

async function acquired(codex: ReturnType<typeof fakeCodex>): Promise<{
  adapter: CodexStructuredSessionAdapter
  published: (AgentSessionBackgroundTaskState | null)[]
}> {
  const published: (AgentSessionBackgroundTaskState | null)[] = []
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: THREAD_ID
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    onBackgroundTasksChanged: (_sessionId, state) => published.push(state)
  })
  await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-9' })
  return { adapter, published }
}

/** The refresh is fire-and-forget, so let its promise chain settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function completeTurn(codex: ReturnType<typeof fakeCodex>): void {
  codex.connections[0].handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: 'turn-1', status: 'completed' }
  })
}

const refuse = (method: string): Route => {
  return () => {
    throw new CodexAppServerUnsupportedError(
      `codex app-server does not support ${method}: method not found`
    )
  }
}

describe('CodexStructuredSessionAdapter background terminals', () => {
  it('surfaces a terminal that outlived its turn', async () => {
    const codex = fakeCodex()
    const { adapter, published } = await acquired(codex)

    completeTurn(codex)
    await settle()

    // Interrupting the turn would not have reaped this; the client can only
    // offer a stop if the host reports it.
    expect(adapter.backgroundTaskState?.('session-1')).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'proc-1', kind: 'command', description: 'sleep 180' }],
      supportsTaskStop: true
    })
    expect(published).toEqual([
      {
        state: 'monitoring',
        tasks: [{ id: 'proc-1', kind: 'command', description: 'sleep 180' }],
        supportsTaskStop: true
      }
    ])
  })

  it('stops every background terminal', async () => {
    const codex = fakeCodex()
    const { adapter } = await acquired(codex)
    completeTurn(codex)
    await settle()

    await expect(
      adapter.stopBackgroundTasks?.({ sessionId: 'session-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(codex.connections[0].calls.some((call) => call.method === CLEAN)).toBe(true)
  })

  it('stops one background terminal by its process id', async () => {
    const codex = fakeCodex()
    const { adapter } = await acquired(codex)
    completeTurn(codex)
    await settle()

    await expect(
      adapter.stopBackgroundTasks?.({ sessionId: 'session-1', fence: 7, taskId: 'proc-1' })
    ).resolves.toEqual({ cancelled: true })
    expect(codex.connections[0].calls).toContainEqual({
      method: TERMINATE,
      params: { threadId: THREAD_ID, processId: 'proc-1' }
    })
  })

  it('clears the published state once the terminals are gone', async () => {
    const codex = fakeCodex()
    const { adapter, published } = await acquired(codex)
    completeTurn(codex)
    await settle()

    codex.routes[LIST] = () => ({ data: [] })
    await adapter.stopBackgroundTasks?.({ sessionId: 'session-1', fence: 7 })
    await settle()

    expect(adapter.backgroundTaskState?.('session-1')).toBeNull()
    expect(published.at(-1)).toBeNull()
  })

  describe('a host without the operations', () => {
    // The dispatcher converts -32601 into CodexAppServerUnsupportedError before
    // any caller sees it, so a RequestError carrying -32601 is a value
    // production can never build. Refuse the way a real host refuses.

    it('offers no control at all rather than one that does nothing', async () => {
      const codex = fakeCodex()
      codex.routes[LIST] = refuse(LIST)
      const { adapter, published } = await acquired(codex)

      completeTurn(codex)
      await settle()

      // Fail closed AND quiet: no state means the client renders no Stop, so a
      // user is never told background work was stopped when it was not.
      expect(adapter.backgroundTaskState?.('session-1')).toBeNull()
      expect(published).toEqual([])
    })

    it('probes once per session instead of on every turn', async () => {
      const codex = fakeCodex()
      codex.routes[LIST] = refuse(LIST)
      await acquired(codex)

      completeTurn(codex)
      await settle()
      completeTurn(codex)
      await settle()

      expect(codex.connections[0].calls.filter((call) => call.method === LIST)).toHaveLength(1)
    })

    it.each([CLEAN, TERMINATE])(
      'publishes capability loss when %s is unsupported',
      async (method) => {
        const codex = fakeCodex()
        codex.routes[method] = refuse(method)
        const { adapter, published } = await acquired(codex)
        completeTurn(codex)
        await settle()

        expect(published).toHaveLength(1)
        expect(published[0]?.state).toBe('monitoring')
        await expect(
          adapter.stopBackgroundTasks?.({
            sessionId: 'session-1',
            fence: 7,
            ...(method === TERMINATE ? { taskId: 'proc-1' } : {})
          })
        ).resolves.toEqual({ cancelled: false })
        expect(adapter.backgroundTaskState?.('session-1')).toBeNull()
        expect(published).toHaveLength(2)
        expect(published.at(-1)).toBeNull()
        completeTurn(codex)
        await settle()
        expect(published).toHaveLength(2)
      }
    )
  })

  it('does not revive a disabled capability from an in-flight list', async () => {
    const codex = fakeCodex()
    const { adapter, published } = await acquired(codex)
    completeTurn(codex)
    await settle()
    const response = { data: [{ processId: 'proc-1', command: 'sleep 180' }] }
    let finishList!: (value: typeof response) => void
    codex.routes[LIST] = () =>
      new Promise((resolve) => {
        finishList = resolve
      })
    completeTurn(codex)
    await settle()
    codex.routes[CLEAN] = refuse(CLEAN)

    await adapter.stopBackgroundTasks?.({ sessionId: 'session-1', fence: 7 })
    expect(published).toHaveLength(2)
    expect(published.at(-1)).toBeNull()
    finishList(response)
    await settle()
    expect(adapter.backgroundTaskState?.('session-1')).toBeNull()
    expect(published).toHaveLength(2)
    const calls = codex.connections[0].calls.length
    completeTurn(codex)
    await settle()
    expect(codex.connections[0].calls).toHaveLength(calls)
  })

  it('does not publish a delayed stop from a replaced session', async () => {
    const codex = fakeCodex()
    const { adapter, published } = await acquired(codex)
    completeTurn(codex)
    await settle()
    let rejectStop!: (error: Error) => void
    codex.routes[CLEAN] = () =>
      new Promise((_resolve, reject) => {
        rejectStop = reject
      })
    const stopping = adapter.stopBackgroundTasks({ sessionId: 'session-1', fence: 7 })
    await settle()
    await adapter.closeSession('session-1')
    await adapter.acquire({ identity: identity(), fence: 8, spawnToken: 'spawn-10' })
    const delivered = published.length
    rejectStop(new CodexAppServerUnsupportedError('method not found'))
    await stopping
    await settle()
    expect(published).toHaveLength(delivered)
    expect(adapter.backgroundTaskState('session-1')).toBeNull()
  })

  it('refuses a stop aimed at a superseded child', async () => {
    const codex = fakeCodex()
    const { adapter } = await acquired(codex)
    completeTurn(codex)
    await settle()
    const before = codex.connections[0].calls.length

    await expect(
      adapter.stopBackgroundTasks?.({ sessionId: 'session-1', fence: 6 })
    ).resolves.toEqual({ cancelled: false })
    expect(codex.connections[0].calls).toHaveLength(before)
  })

  it('never asks an unrelated thread for its terminals', async () => {
    const codex = fakeCodex()
    await acquired(codex)

    codex.connections[0].handlers.onNotification?.('turn/completed', {
      threadId: 'other-thread',
      turn: { id: 'turn-9', status: 'completed' }
    })
    await settle()

    expect(codex.connections[0].calls.some((call) => call.method === LIST)).toBe(false)
  })
})
