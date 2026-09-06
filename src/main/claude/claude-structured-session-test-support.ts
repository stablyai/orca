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
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredLaunch,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

export const PROVIDER_SESSION_ID = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

export const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
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

export type FakeConnection = Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
  closed: boolean
  exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  closeCount: number
}

export function fakeClaude(
  options: {
    initSessionId?: string
    initUuid?: string
    initModel?: string
    initProof?: 'init' | 'session-start' | 'none'
    initAccount?: unknown
    exitBeforeInit?: string
    settings?: unknown
    replayUuid?: string | null
    replayUuids?: (string | null)[]
    capabilities?: string[]
    unprovenCloseVerdict?: ClaudeStreamJsonConnection['exitVerdict']
    routes?: Record<string, Route>
  } = {}
): {
  connections: FakeConnection[]
  openConnection: typeof openClaudeStreamJsonConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const routes = options.routes ?? {}
  let replayIndex = 0
  const routed = (subtype: string, params?: Record<string, unknown>): unknown => {
    const route = routes[subtype]
    return route ? route(params) : undefined
  }
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      initializationResult: async () => {
        connection.calls.push({ subtype: 'initialize' })
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
          // Keys mirror the real system/init frame, which carries `model` but no
          // effort of any kind: the current effort only comes back from
          // get_settings. Never add a field the CLI does not send.
          handlers.onMessage?.({
            type: 'system',
            subtype: 'init',
            session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
            uuid: options.initUuid ?? 'init-uuid',
            model: options.initModel ?? 'claude-sonnet-5',
            apiKeySource: 'none',
            ...(options.capabilities ? { capabilities: options.capabilities } : {})
          })
        }
        return {
          models: [{ value: 'claude-sonnet', displayName: 'Sonnet' }],
          ...(options.initAccount === undefined ? {} : { account: options.initAccount })
        }
      },
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        // Shape measured from Claude Code 2.1.258: {applied, effective, sources},
        // and the only place the session's current effort is reported.
        return (
          options.settings ?? {
            applied: { model: 'claude-sonnet-5', effort: 'high', advisor: null, ultracode: false },
            effective: { model: 'claude-sonnet-5', effortLevel: 'high', env: {} },
            sources: {}
          }
        )
      },
      supportedModels: async () => {
        connection.calls.push({ subtype: 'list_models' })
        return (routed('list_models') as unknown[] | undefined) ?? []
      },
      setModel: async (model) => {
        connection.calls.push({ subtype: 'set_model', params: { model } })
        routed('set_model', { model })
      },
      setPermissionMode: async (mode) => {
        connection.calls.push({ subtype: 'set_permission_mode', params: { mode } })
        routed('set_permission_mode', { mode })
      },
      applyFlagSettings: async (settings) => {
        connection.calls.push({ subtype: 'apply_flag_settings', params: { settings } })
        routed('apply_flag_settings', { settings })
      },
      interrupt: async (interruptOptions) => {
        connection.calls.push({
          subtype: 'interrupt',
          params: interruptOptions?.cancelQueued ? { cancelQueued: true } : {}
        })
        return routed('interrupt', interruptOptions) as
          | Awaited<ReturnType<ClaudeStreamJsonConnection['interrupt']>>
          | undefined
      },
      cancelAsyncMessage: async (uuid) => {
        connection.calls.push({ subtype: 'cancel_async_message', params: { uuid } })
        routed('cancel_async_message', { uuid })
      },
      stopTask: async (taskId) => {
        connection.calls.push({ subtype: 'stop_task', params: { taskId } })
        routed('stop_task', { taskId })
      },
      send: async (message) => {
        connection.sent.push(message)
        if (message.type === 'user' && options.replayUuid !== null) {
          const configuredReplayUuid = options.replayUuids
            ? options.replayUuids[replayIndex++]
            : options.replayUuid
          const replayUuid =
            configuredReplayUuid === undefined ? `user-uuid-${replayIndex}` : configuredReplayUuid
          if (replayUuid !== null) {
            handlers.onMessage?.({
              ...message,
              uuid: replayUuid
            })
          }
        }
      },
      exitVerdict: options.unprovenCloseVerdict ?? { root: 'live', tree: 'unverifiable' },
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return options.unprovenCloseVerdict === undefined
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
  readTranscriptLeaf?: ClaudeStructuredSessionAdapterDeps['readTranscriptLeaf'],
  persistHandle?: ClaudeStructuredSessionAdapterDeps['persistHandle'],
  onBackgroundTasksChanged?: ClaudeStructuredSessionAdapterDeps['onBackgroundTasksChanged']
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
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
    dispatchAckTimeoutMs: 10,
    persistHandle:
      persistHandle ??
      (async (handle) => {
        persistedHandles.push(handle)
      }),
    ...(onBackgroundTasksChanged ? { onBackgroundTasksChanged } : {}),
    ...(readTranscriptLeaf ? { readTranscriptLeaf } : {})
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

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function invokeCanUseTool(
  connection: FakeConnection,
  toolName: string,
  requestId: string,
  toolUseID: string,
  extra: {
    input?: Record<string, unknown>
    suggestions?: unknown[]
    signal?: AbortSignal
  } = {}
): { promise: Promise<unknown>; settled: () => boolean } {
  const options = {
    requestId,
    toolUseID,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.suggestions ? { suggestions: extra.suggestions } : {})
  } as unknown as Parameters<NonNullable<ClaudeStreamJsonConnectionHandlers['canUseTool']>>[2]
  let done = false
  const promise = Promise.resolve(
    connection.handlers.canUseTool?.(toolName, extra.input ?? {}, options)
  ).finally(() => {
    done = true
  })
  return { promise, settled: () => done }
}
