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
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
export { claudeStartupSettled } from './claude-structured-startup-settled-test-support'

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
    providerHandle: claudeProviderHandle(PROVIDER_SESSION_ID, null)
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
    /** 'session-start' (default) mirrors live with a SessionStart hook installed: its
     *  frame proves the session and system/init arrives only when the first command starts a
     *  cycle; 'none' mirrors live without one.
     *  'init' emits init at startup — an UNMEASURED shape, opt-in only. */
    initProof?: 'init' | 'session-start' | 'none'
    initAccount?: unknown
    initCommands?: unknown
    /** The initialize result's `models`, which the SDK also answers `list_models` from. */
    initModels?: unknown[]
    /** What `get_context_usage` answers; defaults to an empty, unusable report. */
    contextUsage?: unknown
    exitBeforeInit?: string
    /** Host-clock delay before the CLI answers initialize, as on a loaded machine. */
    initDelayMs?: number
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
  const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers = {}) => {
    let cycleInitEmitted = false
    // Keys mirror the real system/init frame, which carries `model` but no
    // effort of any kind: the current effort only comes back from get_settings.
    // Never add a field the CLI does not send.
    const emitCycleInit = (): void => {
      cycleInitEmitted = true
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
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      pauseReading: () => {},
      resumeReading: () => {},
      initializationResult: async () => {
        connection.calls.push({ subtype: 'initialize' })
        if (options.initDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.initDelayMs))
        }
        if (options.exitBeforeInit) {
          connection.closed = true
          handlers.onExit?.(new Error(options.exitBeforeInit))
          // The SDK rejects pending control requests once the transport ends.
          throw new Error('Query closed before response received')
        }
        if (options.initProof === 'init') {
          // UNMEASURED startup shape, kept only as an explicit opt-in: live
          // sessions prove startup with a SessionStart hook frame instead.
          emitCycleInit()
        } else if (options.initProof !== 'none') {
          // The live order with a SessionStart hook installed (Orca's status hooks):
          // its frames arrive first; system/init only when a cycle starts. Without
          // one, nothing arrives before the first turn ('none').
          handlers.onMessage?.({
            type: 'system',
            subtype: 'hook_started',
            hook_name: 'SessionStart:startup',
            session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
            uuid: options.initUuid ?? 'init-uuid'
          })
          handlers.onMessage?.({
            type: 'system',
            subtype: 'hook_response',
            hook_name: 'SessionStart:startup',
            session_id: options.initSessionId ?? PROVIDER_SESSION_ID,
            uuid: 'hook-response-uuid'
          })
        }
        return {
          models: options.initModels ?? [{ value: 'claude-sonnet', displayName: 'Sonnet' }],
          // Capabilities ride the initialize result, where startup facts read
          // them regardless of when the first init frame arrives.
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
          ...(options.initCommands === undefined ? {} : { commands: options.initCommands }),
          ...(options.initAccount === undefined ? {} : { account: options.initAccount })
        }
      },
      getContextUsage: async () => {
        connection.calls.push({ subtype: 'get_context_usage' })
        return options.contextUsage ?? {}
      },
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        // Shape measured from Claude Code 2.1.258: {applied, effective, sources}. A launch
        // `--effort` shows only in `applied`, with no `effective.effortLevel` (2.1.280).
        const launched = launch.options.effort
        return (
          options.settings ?? {
            applied: { model: 'claude-sonnet-5', effort: launched ?? 'high', ultracode: false },
            effective: { model: 'claude-sonnet-5', ...(launched ? {} : { effortLevel: 'high' }) },
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
        await routed('set_model', { model })
      },
      setPermissionMode: async (mode) => {
        connection.calls.push({ subtype: 'set_permission_mode', params: { mode } })
        routed('set_permission_mode', { mode })
      },
      applyFlagSettings: async (settings) => {
        connection.calls.push({ subtype: 'apply_flag_settings', params: { settings } })
        await routed('apply_flag_settings', { settings })
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
        return routed('cancel_async_message', { uuid }) === true
      },
      stopTask: async (taskId) => {
        connection.calls.push({ subtype: 'stop_task', params: { taskId } })
        routed('stop_task', { taskId })
      },
      send: async (message, beforeDispatch) => {
        if (beforeDispatch) {
          await beforeDispatch()
        }
        connection.sent.push(message)
        // Live: the first command starts a request cycle, whose init precedes
        // the replay. Later cycles are the test's own frames.
        if (message.type === 'user' && !cycleInitEmitted && options.initProof !== 'none') {
          emitCycleInit()
        }
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
  }
  return { connections, openConnection, routes }
}

/** Acquisition resolves only once startup has landed, as suites written before
 *  publish-first expect; `adapterAtPublishFor` observes the published window itself. */
export function adapterFor(
  ...args: Parameters<typeof adapterAtPublishFor>
): ClaudeStructuredSessionAdapter {
  const adapter = adapterAtPublishFor(...args)
  const acquire = adapter.acquire
  adapter.acquire = async (input) => {
    const acquisition = await acquire(input)
    await adapter['sessions'].get(input.identity.sessionId)?.startup.settled
    return acquisition
  }
  return adapter
}

export function adapterAtPublishFor(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = [],
  persistedHandles: unknown[] = [],
  requestTimeoutMs?: number,
  persistHandle?: ClaudeStructuredSessionAdapterDeps['persistHandle'],
  onChildWorkEvidence?: ClaudeStructuredSessionAdapterDeps['onChildWorkEvidence'],
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    persistHandle:
      persistHandle ??
      (async (handle) => {
        persistedHandles.push(handle)
      }),
    ...(onChildWorkEvidence ? { onChildWorkEvidence } : {}),
    ...(onDispatchSettledLate ? { onDispatchSettledLate } : {})
  })
}

export async function acquired(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {},
  events: ClaudeStructuredSessionEvent[] = [],
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']
): Promise<ClaudeStructuredSessionAdapter> {
  const adapter = adapterFor(
    claude,
    launch,
    events,
    undefined,
    undefined,
    undefined,
    undefined,
    onDispatchSettledLate
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    // Production acquires with a journal sink, and turn identity lives on the
    // translator it builds; without one this fixture models no session that ships.
    events: recordingJournalSink()
  })
  return adapter
}

export function recordingJournalSink(): StructuredAgentSessionEventSink {
  return { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Delivers one frame from Claude on `connection`, under the provider session it runs. */
export function claudeFrame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

/** Whether anything sent to Claude on `connection` carries `text`. */
export function claudeWasSent(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}
