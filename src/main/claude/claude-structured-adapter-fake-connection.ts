import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type {
  ClaudeStructuredLaunch,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

export const PROVIDER_SESSION_ID = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

export const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

export function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function identityFor(sessionId = 'session-1'): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  }
}

type Route = (params: Record<string, unknown> | undefined) => unknown

export type FakeClaudeConnection = Omit<ClaudeStreamJsonConnection, 'closed'> & {
  closed: boolean
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  replies: { requestId: string; response?: unknown; error?: string }[]
  closeCount: number
}

export function fakeClaude(
  options: {
    initSessionId?: string
    initUuid?: string
    initModel?: string
    initEffort?: string
    initProof?: 'init' | 'session-start' | 'none'
    initAccount?: unknown
    exitBeforeInit?: string
    settings?: unknown
    replayUuid?: string | null
    sendError?: Error
    sendErrorAfterReplay?: Error
    onSend?: (
      message: Record<string, unknown>,
      handlers: ClaudeStreamJsonConnectionHandlers
    ) => void | Promise<void>
    routes?: Record<string, Route>
  } = {}
): {
  connections: FakeClaudeConnection[]
  openConnection: typeof openClaudeStreamJsonConnection
  routes: Record<string, Route>
} {
  const connections: FakeClaudeConnection[] = []
  const routes = options.routes ?? {}
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeClaudeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (subtype, params) => {
        connection.calls.push({ subtype, params })
        if (subtype === 'initialize') {
          if (options.exitBeforeInit) {
            handlers.onExit?.(new Error(options.exitBeforeInit))
            return { models: [] }
          }
          if (options.initProof === 'session-start') {
            handlers.onMessage?.({
              type: 'system',
              subtype: 'hook_started',
              hook_name: 'SessionStart:startup',
              session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
              uuid: options.initUuid ?? 'init-uuid'
            })
          } else if (options.initProof !== 'none') {
            handlers.onMessage?.({
              type: 'system',
              subtype: 'init',
              session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
              uuid: options.initUuid ?? 'init-uuid',
              model: options.initModel ?? 'claude-sonnet-5',
              effortLevel: options.initEffort ?? 'high',
              apiKeySource: 'none'
            })
          }
          return {
            models: [{ value: 'claude-sonnet', displayName: 'Sonnet' }],
            ...(options.initAccount === undefined ? {} : { account: options.initAccount })
          }
        }
        if (subtype === 'get_settings') {
          return options.settings ?? { env: {} }
        }
        const route = routes[subtype]
        return route ? route(params) : {}
      },
      send: async (message) => {
        connection.sent.push(message)
        await options.onSend?.(message, handlers)
        if (options.sendError) {
          throw options.sendError
        }
        if (message.type === 'user' && options.replayUuid !== null) {
          handlers.onMessage?.({
            ...message,
            uuid: options.replayUuid ?? message.uuid,
            isReplay: true
          })
        }
        if (options.sendErrorAfterReplay) {
          throw options.sendErrorAfterReplay
        }
      },
      respond: async (requestId, response) => {
        connection.replies.push({ requestId, response })
      },
      respondWithError: async (requestId, error) => {
        connection.replies.push({ requestId, error })
      },
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openClaudeStreamJsonConnection
  return { connections, openConnection, routes }
}

export function adapterFor(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = [],
  persistedHandles: unknown[] = [],
  initTimeoutMs?: number,
  persistHandleOverride?: () => Promise<void>
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'claude',
      args: ['-p'],
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    ...(initTimeoutMs === undefined ? {} : { initTimeoutMs }),
    persistHandle: async (handle) => {
      await persistHandleOverride?.()
      persistedHandles.push(handle)
    }
  })
}

export async function acquired(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = []
): Promise<ClaudeStructuredSessionAdapter> {
  const adapter = adapterFor(claude, launch, events)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}
