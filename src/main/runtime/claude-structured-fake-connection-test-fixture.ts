// A fake Claude stream-json child for the structured-session integration suite.

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
}

export function fakeClaude(providerSession: string) {
  const connections: FakeClaudeConnection[] = []
  let initializeAccount: unknown
  /** A child that dies during start, with the close verdict its ladder observed. */
  let selfExit: { message: string; exitVerdict: ClaudeStreamJsonConnection['exitVerdict'] } | null =
    null
  let contextUsage: () => Promise<unknown> = async () => ({})
  /** Holds every close until it settles: the close ladder a real child's exit runs through. */
  let closeGate: Promise<void> | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers every control request the session issues; the real opener's signature is what the runtime under test calls.
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeClaudeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      pid: 4321 + connections.length,
      closed: false,
      initializationResult: async () => {
        connection.calls.push({ subtype: 'initialize' })
        if (selfExit) {
          handlers.onExit?.(new Error(selfExit.message))
          return { models: [] }
        }
        handlers.onMessage?.({
          type: 'system',
          subtype: 'init',
          session_id: providerSession,
          ...(connections.length === 0 ? { uuid: 'init-leaf' } : {}),
          model: 'claude-sonnet-5',
          apiKeySource: 'none'
        })
        return {
          models: [{ value: 'sonnet', displayName: 'Sonnet' }],
          ...(initializeAccount === undefined ? {} : { account: initializeAccount })
        }
      },
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        return { env: {} }
      },
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
      cancelAsyncMessage: async () => {},
      stopTask: async (taskId) => {
        connection.calls.push({ subtype: 'stop_task', params: { taskId } })
      },
      send: async (message) => {
        connection.sent.push(message)
        if (message.type === 'user') {
          handlers.onMessage?.({ ...message, uuid: 'user-1' })
        }
      },
      exitVerdict: selfExit?.exitVerdict ?? { root: 'live', tree: 'unverifiable' },
      close: async () => {
        connection.closed = true
        await closeGate
        return selfExit === null || selfExit.exitVerdict.tree === 'exited'
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
    setSelfExit: (exit: typeof selfExit) => {
      selfExit = exit
    },
    setContextUsage: (answer: () => Promise<unknown>) => {
      contextUsage = answer
    },
    holdClose: (gate: Promise<void> | null) => {
      closeGate = gate
    }
  }
}
