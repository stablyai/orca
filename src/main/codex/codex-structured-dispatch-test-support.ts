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
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type {
  StructuredAgentSessionLateSettlement,
  StructuredAgentSessionLateSettlementResult
} from '../native-chat/agent-session-wire/structured-agent-session-late-settlement'

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

export type LateSettlement = StructuredAgentSessionLateSettlement

/** A `codex app-server` whose turn traffic the test drives by hand. */
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
        const result = routes[method]?.(params) ?? {}
        options?.onResult?.(result)
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

/** A sink that records nothing but keeps the translator alive, which is what
 *  mints the identities a late settlement carries. */
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
  events?: CodexStructuredSessionEvent[]
  settleLateDispatch?: (
    settlement: LateSettlement
  ) => Promise<StructuredAgentSessionLateSettlementResult>
  captureTurnProcesses?: CodexStructuredSessionAdapterDeps['captureTurnProcesses']
}): Promise<CodexStructuredSessionAdapter> {
  const events = input.events
  const terminalTurnIds = new Set<string>()
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
    captureTurnProcesses: input.captureTurnProcesses ?? (async () => null),
    now: () => 1_700_000_000_500,
    onDispatchSettledLate: async (settlement) => {
      if (input.settleLateDispatch) {
        return input.settleLateDispatch(settlement)
      }
      if ('turnId' in settlement && !terminalTurnIds.has(settlement.turnId)) {
        return 'evidence-not-durable'
      }
      input.settlements.push(settlement)
      return 'settled'
    },
    onEvent: (event) => {
      if (event.type === 'notification' && event.method === 'turn/completed') {
        const turnId = readCodexTurnId(event.params)
        if (turnId) {
          terminalTurnIds.add(turnId)
        }
      }
      events?.push(event)
    }
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
