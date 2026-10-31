import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredLaunch
} from './claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  type claudeInitialization,
  claudeInitializationScope,
  claudeStartupSettled
} from './claude-structured-startup-settled-test-support'

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
  initialization: ReturnType<typeof claudeInitialization>
}

export function fakeClaude(
  options: {
    initSessionId?: string
    initUuid?: string
    initModel?: string
    initPermissionMode?: string
    /** Default: live SessionStart proof; 'none': no hook; 'init': unmeasured startup shape. */
    initProof?: 'init' | 'session-start' | 'none'
    initAccount?: unknown
    initCommands?: unknown
    initModels?: unknown[]
    contextUsage?: unknown
    holdInit?: boolean
    initDelayMs?: number
    settings?: unknown
    replayUuid?: string | null
    replayUuids?: (string | null)[]
    capabilities?: string[]
    unprovenCloseVerdict?: ClaudeStreamJsonConnection['exitVerdict']
    routes?: Record<string, Route>
  } = {}
) {
  const connections: FakeConnection[] = []
  const routes = options.routes ?? {}
  const { create, dispose } = claudeInitializationScope()
  let replayIndex = 0
  const routed = (subtype: string, params?: Record<string, unknown>): unknown =>
    routes[subtype]?.(params)
  const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers = {}) => {
    const config = { ...options }
    let cycleInitEmitted = false
    // Live init reports model; effort comes only from get_settings.
    const emitCycleInit = (): void => {
      cycleInitEmitted = true
      handlers.onMessage?.({
        type: 'system',
        subtype: 'init',
        session_id: config.initSessionId ?? PROVIDER_SESSION_ID,
        uuid: config.initUuid ?? 'init-uuid',
        model: config.initModel ?? 'claude-sonnet-5',
        ...(config.initPermissionMode ? { permissionMode: config.initPermissionMode } : {}),
        apiKeySource: 'none',
        ...(config.capabilities ? { capabilities: config.capabilities } : {})
      })
    }
    const initialization = create({
      held: config.holdInit,
      delayMs: config.initDelayMs,
      synchronous: true,
      response: {
        models: config.initModels ?? [{ value: 'claude-sonnet', displayName: 'Sonnet' }],
        ...(config.capabilities ? { capabilities: config.capabilities } : {}),
        ...(config.initCommands === undefined ? {} : { commands: config.initCommands }),
        ...(config.initAccount === undefined ? {} : { account: config.initAccount })
      },
      deliver: () => {
        if (config.initProof === 'init') {
          emitCycleInit()
        } else if (config.initProof !== 'none') {
          // Live SessionStart hooks precede system/init, which waits for the first cycle.
          handlers.onMessage?.({
            type: 'system',
            subtype: 'hook_started',
            hook_name: 'SessionStart:startup',
            session_id: config.initSessionId ?? PROVIDER_SESSION_ID,
            uuid: config.initUuid ?? 'init-uuid'
          })
          handlers.onMessage?.({
            type: 'system',
            subtype: 'hook_response',
            hook_name: 'SessionStart:startup',
            session_id: config.initSessionId ?? PROVIDER_SESSION_ID,
            uuid: 'hook-response-uuid'
          })
        }
      }
    })
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      initialization,
      pauseReading: () => {},
      resumeReading: () => {},
      initializationResult: () => initialization.read(connection.calls),
      renameSession: async () => {},
      getContextUsage: async () => {
        connection.calls.push({ subtype: 'get_context_usage' })
        return config.contextUsage ?? {}
      },
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        // Captured in 2.1.280: launch --effort appears in applied, not effective.effortLevel.
        const launched = launch.options.effort
        return (
          config.settings ?? {
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
        await beforeDispatch?.()
        connection.sent.push(message)
        // Emit live init-before-replay ordering once; tests supply later cycles.
        if (message.type === 'user' && !cycleInitEmitted && config.initProof !== 'none') {
          emitCycleInit()
        }
        if (message.type === 'user' && config.replayUuid !== null) {
          const configuredReplayUuid = config.replayUuids
            ? config.replayUuids[replayIndex++]
            : config.replayUuid
          const replayUuid =
            configuredReplayUuid === undefined ? `user-uuid-${replayIndex}` : configuredReplayUuid
          if (replayUuid !== null) {
            handlers.onMessage?.({ ...message, uuid: replayUuid })
          }
        }
      },
      exitVerdict: config.unprovenCloseVerdict ?? { root: 'live', tree: 'unverifiable' },
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        initialization.dispose()
        return config.unprovenCloseVerdict === undefined
      }
    }
    connections.push(connection)
    return connection
  }
  return { connections, openConnection, routes, dispose }
}

/** Direct adapter fixtures await the host-owned open after process publication. */
export function adapterFor(...args: Parameters<typeof adapterAtPublishFor>) {
  const adapter = adapterAtPublishFor(...args)
  const acquire = adapter.acquire
  adapter.acquire = async (input) => {
    const acquisition = await acquire(input)
    await claudeStartupSettled(adapter, input.identity.sessionId)
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
    resolveLaunch: async ({ spawnToken }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: false,
      ...launch,
      env: { ...launch.env, [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: spawnToken }
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
    // A journal sink enables the translator that owns turn identity.
    events: recordingJournalSink()
  })
  return adapter
}

export function recordingJournalSink(): StructuredAgentSessionEventSink {
  return { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function claudeFrame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

export function claudeWasSent(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}
