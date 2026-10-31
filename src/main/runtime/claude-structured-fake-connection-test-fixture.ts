import {
  type claudeInitialization,
  claudeInitializationScope
} from '../claude/claude-structured-startup-settled-test-support'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from '../claude/claude-stream-json-connection'

export type FakeClaudeConnection = Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
  closed: boolean
  exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  initialization: ReturnType<typeof claudeInitialization>
  closeProven: boolean
}

export function fakeClaude(providerSession: string) {
  const connections: FakeClaudeConnection[] = []
  let initializeAccount: unknown
  let initializeHeld = false
  const initializationScope = claudeInitializationScope()
  let disposed = false
  let contextUsage: () => Promise<unknown> = async () => ({})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers every control request the session issues; the real opener's signature is what the runtime under test calls.
  const openConnection = (async (launch, handlers = {}) => {
    const initialization = initializationScope.create({
      held: initializeHeld,
      response: {
        models: [{ value: 'sonnet', displayName: 'Sonnet' }],
        ...(initializeAccount === undefined ? {} : { account: initializeAccount })
      },
      deliver: () =>
        handlers.onMessage?.({
          type: 'system',
          subtype: 'init',
          session_id: providerSession,
          model: 'claude-sonnet-5',
          apiKeySource: 'none'
        })
    })
    const connection: FakeClaudeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      pid: 4321 + connections.length,
      closed: false,
      initialization,
      closeProven: true,
      initializationResult: () => initialization.read(connection.calls),
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        return { env: {} }
      },
      renameSession: async () => {},
      getContextUsage: async () => {
        connection.calls.push({ subtype: 'get_context_usage' })
        return contextUsage()
      },
      supportedModels: async () => {
        connection.calls.push({ subtype: 'list_models' })
        return [{ value: 'sonnet', displayName: 'Sonnet' }]
      },
      setModel: async (model) => {
        connection.calls.push({ subtype: 'set_model', params: { model } })
      },
      setPermissionMode: async (mode) => {
        connection.calls.push({ subtype: 'set_permission_mode', params: { mode } })
      },
      applyFlagSettings: async (settings) => {
        connection.calls.push({ subtype: 'apply_flag_settings', params: { settings } })
      },
      interrupt: async () => {
        connection.calls.push({ subtype: 'interrupt', params: {} })
        return undefined
      },
      cancelAsyncMessage: async () => false,
      stopTask: async (taskId) => {
        connection.calls.push({ subtype: 'stop_task', params: { taskId } })
      },
      send: async (message, beforeDispatch) => {
        await beforeDispatch?.()
        connection.sent.push(message)
        if (message.type === 'user') {
          handlers.onMessage?.({ ...message, uuid: 'user-1' })
        }
      },
      exitVerdict: { root: 'live', tree: 'unverifiable' },
      close: async () => {
        connection.closed = true
        initialization.dispose()
        return disposed || connection.closeProven
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openClaudeStreamJsonConnection
  const live = (): FakeClaudeConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no Claude connection')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    setInitializeAccount: (account: unknown) => {
      initializeAccount = account
    },
    setInitializeHeld: (held: boolean) => {
      initializeHeld = held
    },
    dispose: () => {
      disposed = true
      initializationScope.dispose()
    },
    setContextUsage: (answer: () => Promise<unknown>) => {
      contextUsage = answer
    }
  }
}
