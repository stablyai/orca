import type {
  AgentJournalItemIdentity,
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
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

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

export type LateSettlement = {
  sessionId: string
  clientMessageId: string
  providerIdentity: AgentJournalItemIdentity
}

/** A `codex app-server` whose turn traffic the test drives by hand. */
export function fakeCodexAppServer(routes: Record<string, CodexTestRoute> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, CodexTestRoute>
} {
  const connections: FakeConnection[] = []
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
  routes['thread/start'] ??= () => ({
    thread: { id: CODEX_TEST_THREAD_ID, path: '/rollouts/abc.jsonl' }
  })
  return { connections, openConnection, routes }
}

/** A sink that records nothing but keeps the translator alive, which is what
 *  mints the identities a late settlement carries. */
export function recordingSink(): StructuredAgentSessionEventSink {
  return {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {}
  } as unknown as StructuredAgentSessionEventSink
}

export async function acquiredCodexAdapter(input: {
  codex: ReturnType<typeof fakeCodexAppServer>
  settlements: LateSettlement[]
  sink?: StructuredAgentSessionEventSink
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
    onDispatchSettledLate: (settlement) => input.settlements.push(settlement)
  })
  const identity: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: CODEX_TEST_THREAD_ID }
  }
  await adapter.acquire({
    identity,
    fence: 7,
    spawnToken: 'spawn-9',
    events: input.sink ?? recordingSink()
  })
  return adapter
}

/** Codex's own echo of a user message Orca sent, inside `turnId`. */
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

export function startTurn(connection: FakeConnection, turnId: string): void {
  connection.handlers.onNotification?.('turn/started', {
    threadId: CODEX_TEST_THREAD_ID,
    turn: { id: turnId }
  })
}
