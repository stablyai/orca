import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

const opened = new WeakMap<
  ClaudeStructuredSessionAdapter,
  Map<string, Promise<StructuredAgentSessionProviderOpenResult>>
>()

/** Direct adapter fixtures explicitly join the host-owned open after acquire. */
export function claudeOpened(
  adapter: ClaudeStructuredSessionAdapter,
  sessionId: string
): Promise<StructuredAgentSessionProviderOpenResult> {
  let sessions = opened.get(adapter)
  if (!sessions) {
    sessions = new Map()
    opened.set(adapter, sessions)
  }
  const session = adapter['sessions'].get(sessionId)
  if (!session) {
    return Promise.reject(new Error(`no Claude session for ${sessionId}`))
  }
  const key = `${sessionId}:${session.acquisitionGeneration}`
  const previous = sessions.get(key)
  if (previous) {
    return previous
  }
  const current = adapter.open({
    sessionId,
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    signal: new AbortController().signal
  })
  sessions.set(key, current)
  return current
}

export async function claudeStartupSettled(
  adapter: ClaudeStructuredSessionAdapter,
  sessionId: string
): Promise<void> {
  await claudeOpened(adapter, sessionId)
}

/** One query response; transport events are independent test inputs. */
export function claudeInitialization(options: {
  response: unknown
  held?: boolean
  delayMs?: number
  deliver: () => void
  synchronous?: boolean
}) {
  const result = Promise.withResolvers<unknown>()
  void result.promise.catch(() => {})
  let pending = true
  let successful = false
  let terminal = false
  let observed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const resolve = (response = options.response): void => {
    if (!pending) {
      return
    }
    pending = false
    successful = true
    clearTimeout(timer)
    result.resolve(response)
  }
  const reject = (error: unknown): void => {
    if (!pending) {
      return
    }
    pending = false
    clearTimeout(timer)
    result.reject(error)
  }
  if (!options.held) {
    if (options.delayMs === undefined) {
      resolve()
    } else {
      timer = setTimeout(resolve, options.delayMs)
    }
  }
  return {
    promise: result.promise,
    get disposed() {
      return terminal
    },
    resolve,
    reject,
    read(calls: { subtype: string }[]) {
      calls.push({ subtype: 'initialize' })
      if (!observed) {
        observed = true
        const deliver = (): void => {
          if (!terminal) {
            options.deliver()
          }
        }
        if (options.synchronous && successful) {
          deliver()
        } else {
          void result.promise.then(deliver).catch(() => {})
        }
      }
      return result.promise
    },
    dispose() {
      terminal = true
      reject(new Error('Query closed before response received'))
    }
  }
}

/** Dispose unanswered responses and suppress proof even for late-created connections. */
export function claudeInitializationScope() {
  const responses = new Set<ReturnType<typeof claudeInitialization>>()
  let disposed = false
  return {
    create(options: Parameters<typeof claudeInitialization>[0]) {
      const response = claudeInitialization({ ...options, held: disposed || options.held })
      if (disposed) {
        response.dispose()
      } else {
        responses.add(response)
      }
      return response
    },
    dispose() {
      disposed = true
      for (const response of responses) {
        response.dispose()
      }
      responses.clear()
    }
  }
}
