import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionOptionsReportedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
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
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const startLinks = new WeakMap<
  CodexStructuredSessionAdapter,
  Map<string, NonNullable<StructuredAgentSessionProviderOpenResult['link']>>
>()
const startReports = new WeakMap<
  CodexStructuredSessionAdapter,
  Map<string, StructuredAgentSessionProviderOpenResult | StructuredAgentSessionOptionsReportedEvent>
>()

export function codexStartReport(adapter: CodexStructuredSessionAdapter, sessionId = 'session-1') {
  const report = startReports.get(adapter)?.get(sessionId)
  if (!report) {
    throw new Error(`Codex has not started ${sessionId}`)
  }
  return report
}

export function codexStartedLink(adapter: CodexStructuredSessionAdapter, sessionId = 'session-1') {
  return startLinks.get(adapter)?.get(sessionId)
}

export async function acquireReadyCodexForTest(
  adapter: CodexStructuredSessionAdapter,
  input: StructuredAgentSessionAcquireInput
) {
  const acquired = await adapter.acquire(input)
  const result = await adapter.open({
    sessionId: input.identity.sessionId,
    fence: input.fence,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  startReports.get(adapter)?.set(input.identity.sessionId, result)
  if (result.link) {
    startLinks.get(adapter)?.set(input.identity.sessionId, result.link)
  }
  return acquired
}

export const THREAD_ID = 'thread-abc'

export function identityFor(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle(THREAD_ID)
  }
}

export const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

export type Route = (params: Record<string, unknown> | undefined) => unknown

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number; message?: string }[]
  closeCount: number
}

export function fakeCodex(routes: Record<string, Route> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
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
      // Match the real connection's synchronous exit report during close.
      close: async () => {
        connection.closeCount += 1
        if (!connection.closed) {
          connection.closed = true
          handlers.onExit?.(new Error('codex app-server connection ended: killed'), {
            expected: true
          })
        }
        return true
      }
    }
    connections.push(connection)
    await handlers.onSpawned?.(connection.pid ?? 0)
    return connection
  }
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

export function answerWithOpenedTurn(
  codex: Pick<ReturnType<typeof fakeCodex>, 'connections'>,
  turnId: string
): Route {
  return () => {
    codex.connections
      .at(-1)
      ?.handlers.onNotification?.('turn/started', { threadId: THREAD_ID, turn: { id: turnId } })
    return { turn: { id: turnId } }
  }
}

export function adapterFor(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = [],
  deps: Partial<CodexStructuredSessionAdapterDeps> = {}
): CodexStructuredSessionAdapter {
  let acquisitionGeneration = 0
  const links = new Map<string, NonNullable<StructuredAgentSessionProviderOpenResult['link']>>()
  const reports = new Map<
    string,
    StructuredAgentSessionProviderOpenResult | StructuredAgentSessionOptionsReportedEvent
  >()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null,
      ...launch
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    mintAcquisitionGeneration: () => `generation-${++acquisitionGeneration}`,
    ...deps,
    onEvent: (event) => {
      if (event.type === 'options-reported') {
        reports.set(event.sessionId, event)
      } else {
        events.push(event)
      }
      deps.onEvent?.(event)
    }
  })
  startReports.set(adapter, reports)
  startLinks.set(adapter, links)
  return adapter
}

export async function acquired(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = []
): Promise<CodexStructuredSessionAdapter> {
  const adapter = adapterFor(codex, launch, events)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9'
  })
  return adapter
}
