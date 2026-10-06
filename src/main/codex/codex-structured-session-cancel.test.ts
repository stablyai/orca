import { describe, expect, it, vi } from 'vitest'

// Every way Orca reads or kills processes, never settling: a Stop that reaches for one hangs.
const processWork = vi.hoisted(() => {
  const never = (): Promise<never> => new Promise(() => {})
  return {
    captureDescendantSnapshot: vi.fn(async () => ({
      rootPgid: null,
      descendants: [],
      capturedAtMs: 0
    })),
    terminateDescendantSnapshotAndWait: vi.fn(never),
    queryWindowsProcessDescendants: vi.fn(never),
    terminateWindowsProcessTree: vi.fn(never)
  }
})
vi.mock('../pty-descendant-termination', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureDescendantSnapshot: processWork.captureDescendantSnapshot
}))
vi.mock('../pty-descendant-exit-verification', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  terminateDescendantSnapshotAndWait: processWork.terminateDescendantSnapshotAndWait
}))
vi.mock('../providers/windows-foreground-process-rows', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryWindowsProcessDescendants: processWork.queryWindowsProcessDescendants
}))
vi.mock('../windows-process-tree-kill', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  terminateWindowsProcessTree: processWork.terminateWindowsProcessTree
}))
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import {
  CodexAppServerRequestError,
  type CodexAppServerConnection,
  type CodexAppServerConnectionHandlers,
  type CodexAppServerLaunch,
  type openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const THREAD_ID = 'thread-abc'
const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

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
    providerHandle: codexProviderHandle(THREAD_ID)
  }
}

function fakeCodex(): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const routes: Record<string, Route> = {
    'thread/resume': () => ({ thread: { id: THREAD_ID } })
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

async function acquired(
  codex: ReturnType<typeof fakeCodex>,
  events: CodexStructuredSessionEvent[] = [],
  overrides: Partial<Pick<CodexStructuredSessionAdapterDeps, 'now'>> = {}
): Promise<CodexStructuredSessionAdapter> {
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: THREAD_ID
    }),
    onEvent: (event) => events.push(event),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    ...overrides
  })
  await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}

function completeTurn(codex: ReturnType<typeof fakeCodex>, turnId = 'turn-1'): void {
  codex.connections[0].handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: turnId, status: 'interrupted' }
  })
}

describe('CodexStructuredSessionAdapter.cancelTurn', () => {
  it('confirms an interrupt Codex acknowledged', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(codex.connections[0].calls.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: THREAD_ID, turnId: 'turn-1' }
    })
  })

  it('reports not-cancelled when Codex declines or lacks the method', async () => {
    const declined = fakeCodex()
    declined.routes['turn/interrupt'] = () => {
      throw new CodexAppServerRequestError('turn/interrupt', -32602, 'no such turn')
    }
    const absent = fakeCodex()
    absent.routes['turn/interrupt'] = () => {
      throw new CodexAppServerUnsupportedError('no turn/interrupt')
    }

    await expect(
      (await acquired(declined)).cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7
      })
    ).resolves.toEqual({ cancelled: false, refusal: {} })
    await expect(
      (await acquired(absent)).cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7
      })
    ).resolves.toEqual({ cancelled: false, refusal: {} })
  })

  it('rethrows an unsettled interrupt so the turn is not shown as cancelled', async () => {
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => {
      throw new Error('codex app-server turn/interrupt exceeded 30000ms')
    }

    await expect(
      (await acquired(codex)).cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7
      })
    ).rejects.toThrow('exceeded 30000ms')
  })

  it('accepts an immediate resend after verified interruption', async () => {
    let nextTurn = 0
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => {
      // Codex opens each turn it answers; a send's dispatch waits for that.
      const turnId = `turn-${++nextTurn}`
      codex.connections[0].handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: turnId }
      })
      return { turn: { id: turnId } }
    }
    codex.routes['turn/interrupt'] = () => {
      completeTurn(codex)
      return {}
    }
    const adapter = await acquired(codex)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    await adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({
      state: 'admitted'
    })
  })

  it("publishes the turn's end when the interrupt receipt fails", async () => {
    const events: CodexStructuredSessionEvent[] = []
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => {
      completeTurn(codex)
      throw new Error('interrupt receipt lost')
    }
    const adapter = await acquired(codex, events)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).rejects.toThrow('interrupt receipt lost')
    expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed' }))
  })
})

// Codex keeps a turn's background terminals alive across an interrupt and kills its one-shot
// commands itself, so a Stop is the interrupt alone.
describe('a Codex Stop is the interrupt alone', () => {
  async function stopAfterASend() {
    const events: CodexStructuredSessionEvent[] = []
    const answer = Promise.withResolvers<unknown>()
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => {
      codex.connections[0].handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn-1' }
      })
      return { turn: { id: 'turn-1' } }
    }
    codex.routes['turn/interrupt'] = () => answer.promise
    const adapter = await acquired(codex, events)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    const stopped = adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('turn/interrupt'))
    // Codex answers the interrupt, then sends the turn's end; one read can carry both.
    const answerThenEnd = (): void => {
      answer.resolve({})
      completeTurn(codex)
    }
    return { events, stopped, answerThenEnd }
  }

  it('publishes the interrupted end the moment Codex sends it', async () => {
    const { events, stopped, answerThenEnd } = await stopAfterASend()

    answerThenEnd()

    expect(events).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({ turn: { id: 'turn-1', status: 'interrupted' } })
      })
    )
    await expect(stopped).resolves.toEqual({ cancelled: true, turnId: 'turn-1' })
  })

  it('reads and kills no processes, from the send through the Stop', async () => {
    const { stopped, answerThenEnd } = await stopAfterASend()

    answerThenEnd()

    for (const work of Object.values(processWork)) {
      expect(work).not.toHaveBeenCalled()
    }
    await expect(stopped).resolves.toEqual({ cancelled: true, turnId: 'turn-1' })
    for (const work of Object.values(processWork)) {
      expect(work).not.toHaveBeenCalled()
    }
  })
})
