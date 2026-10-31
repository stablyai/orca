import { acquireReadyCodexForTest } from './codex-structured-session-adapter-fixture'
import { expect, vi } from 'vitest'
import type { AgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from './app-server/codex-app-server-connection-types'
import type {
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { codexTurnLifecycleFake } from './codex-turn-lifecycle-fake'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

export const CODEX_TEST_THREAD_ID = 'thread-abc'

export const CODEX_TEST_USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

export type CodexTestRoute = (params: Record<string, unknown> | undefined) => unknown

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
}

export type LateSettlement = Parameters<
  NonNullable<CodexStructuredSessionAdapterDeps['onDispatchSettledLate']>
>[0]

export const refuseUnroutedSteer: CodexTestRoute = () => {
  throw new CodexAppServerUnsupportedError(
    'codex app-server does not support turn/steer: method not found'
  )
}

export function fakeCodexAppServer(routes: Record<string, CodexTestRoute> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, CodexTestRoute>
} {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      pid: 4321,
      closed: false,
      request: async (method, params, options) => {
        connection.calls.push({ method, params })
        const route = routes[method] ?? (method === 'turn/steer' ? refuseUnroutedSteer : undefined)
        const routed = route?.(params) ?? {}
        const result = routed instanceof Promise ? await routed : routed
        // The real dispatcher runs onReply at receipt, before the caller's continuation.
        options?.onReply?.(result)
        return result
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
  }
  routes['thread/start'] ??= () => ({
    thread: { id: CODEX_TEST_THREAD_ID, path: '/rollouts/abc.jsonl' }
  })
  return { connections, openConnection, routes }
}

/** A sink is required to activate translation and mint late-settlement identities. */
export function recordingSink(): StructuredAgentSessionEventSink {
  return {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {}
  }
}

export async function acquiredCodexAdapter(input: {
  codex: ReturnType<typeof fakeCodexAppServer>
  settlements: LateSettlement[]
  sink?: StructuredAgentSessionEventSink
  requestTimeoutMs?: number
  permissionMode?: AgentChatPermissionChoice
}): Promise<CodexStructuredSessionAdapter> {
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: input.codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    onDispatchSettledLate: (settlement) => input.settlements.push(settlement),
    ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs })
  })
  const identity: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle(CODEX_TEST_THREAD_ID)
  }
  await acquireReadyCodexForTest(adapter, {
    identity,
    fence: 7,
    spawnToken: 'spawn-9',
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    events: input.sink ?? recordingSink()
  })
  return adapter
}

export function echoUserMessage(
  connection: FakeConnection,
  input: { turnId: string; itemId: string; clientId?: string; threadId?: string }
): void {
  connection.handlers.onNotification?.('item/started', {
    threadId: input.threadId ?? CODEX_TEST_THREAD_ID,
    turn: { id: input.turnId },
    item: {
      type: 'userMessage',
      id: input.itemId,
      ...(input.clientId ? { clientId: input.clientId } : {})
    }
  })
}

export function startTurn(connection: Pick<FakeConnection, 'handlers'>, turnId: string): void {
  connection.handlers.onNotification?.('turn/started', {
    threadId: CODEX_TEST_THREAD_ID,
    turn: { id: turnId }
  })
}

export async function openAfterTurnStarts(
  connection: Pick<FakeConnection, 'calls'>,
  count: number,
  open: () => void
): Promise<void> {
  await vi.waitFor(() =>
    expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(count)
  )
  open()
}

export async function codexTurnLifecycleRig(
  options: { requestTimeoutMs?: number; legacyStartAnswers?: boolean } = {}
) {
  const { legacyStartAnswers, ...adapterOptions } = options
  const codex = fakeCodexAppServer()
  const notify = (method: string, params: unknown): void =>
    codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  const turns = codexTurnLifecycleFake(CODEX_TEST_THREAD_ID, () => notify, { legacyStartAnswers })
  Object.assign(codex.routes, turns.routes)
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements, ...adapterOptions })
  const send = (clientMessageId: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId,
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7
    })
  const interrupts = () =>
    codex.connections[0]!.calls.filter((call) => call.method === 'turn/interrupt')
  return { codex, turns, adapter, send, settlements, notify, interrupts }
}

export function settledWithin<T>(promise: Promise<T>, withinMs = 50): Promise<T | 'held'> {
  return Promise.race([
    promise,
    new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), withinMs))
  ])
}
