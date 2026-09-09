import { describe, expect, it, vi } from 'vitest'
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
  processControl: Partial<
    Pick<CodexStructuredSessionAdapterDeps, 'captureTurnProcesses' | 'terminateTurnProcesses'>
  > = {}
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
    captureTurnProcesses: async () => ({ platform: 'win32', identities: new Map() }),
    terminateTurnProcesses: async () => true,
    ...processControl
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
    ).resolves.toEqual({ cancelled: true })
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
    ).resolves.toEqual({ cancelled: false })
    await expect(
      (await acquired(absent)).cancelTurn({
        sessionId: 'session-1',
        turnId: 'turn-1',
        fence: 7
      })
    ).resolves.toEqual({ cancelled: false })
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

  it('publishes terminal state only after streaming interruption is physically settled', async () => {
    const events: CodexStructuredSessionEvent[] = []
    let finishTermination!: (terminated: boolean) => void
    const termination = new Promise<boolean>((resolve) => {
      finishTermination = resolve
    })
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => {
      completeTurn(codex)
      return {}
    }
    const adapter = await acquired(codex, events, {
      terminateTurnProcesses: async () => termination
    })
    codex.connections[0].handlers.onNotification?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'still streaming'
    })

    const pending = adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    await vi.waitFor(() => expect(codex.connections[0].calls.at(-1)?.method).toBe('turn/interrupt'))
    expect(events).toContainEqual(expect.objectContaining({ method: 'item/agentMessage/delta' }))
    expect(events).not.toContainEqual(expect.objectContaining({ method: 'turn/completed' }))

    finishTermination(true)
    await expect(pending).resolves.toEqual({ cancelled: true })
    expect(events.at(-1)).toMatchObject({ method: 'turn/completed' })
  })

  it('starts physical termination without waiting for the interrupt receipt', async () => {
    let finishInterrupt!: () => void
    const interruptReceipt = new Promise<void>((resolve) => {
      finishInterrupt = resolve
    })
    const terminateTurnProcesses = vi.fn(async () => true)
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => interruptReceipt
    const adapter = await acquired(codex, [], { terminateTurnProcesses })

    const pending = adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    await vi.waitFor(() => expect(terminateTurnProcesses).toHaveBeenCalledOnce())
    finishInterrupt()

    await expect(pending).resolves.toEqual({ cancelled: true })
  })

  it('keeps the turn live when process termination cannot be verified', async () => {
    const events: CodexStructuredSessionEvent[] = []
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => {
      completeTurn(codex)
      return {}
    }
    const adapter = await acquired(codex, events, {
      terminateTurnProcesses: async () => false
    })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed' }))
  })

  it('accepts an immediate resend after verified interruption', async () => {
    let nextTurn = 0
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: `turn-${++nextTurn}` } })
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
    ).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { turnId: 'turn-2' }
    })
  })

  it('does not strand a deferred completion when the interrupt receipt fails', async () => {
    const events: CodexStructuredSessionEvent[] = []
    const codex = fakeCodex()
    codex.routes['turn/interrupt'] = () => {
      completeTurn(codex)
      throw new Error('interrupt receipt lost')
    }
    const adapter = await acquired(codex, events, {
      terminateTurnProcesses: async () => true
    })

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-1', fence: 7 })
    ).rejects.toThrow('interrupt receipt lost')
    expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed' }))
  })
})
