// A fake connection the adapter tests inject through `deps.openConnection`, plus
// the small builders every zcode adapter test shares.

import { expect } from 'vitest'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers
} from './zcode-app-server-connection-types'
import type {
  ZcodeAppServerLaunch,
  openZcodeAppServerConnection
} from './zcode-app-server-connection'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-state'

export const PROVIDER_SESSION = 'sess_provider_1'

type RecordedRequest = { method: string; params: Record<string, unknown> | undefined }

type FakeConnection = ZcodeAppServerConnection & {
  /** Every client→server request the adapter made, in order. */
  requests: RecordedRequest[]
  /** Every reply the adapter wrote to a server request. */
  replies: { id: number | string; result: unknown }[]
  handlers: ZcodeAppServerConnectionHandlers
  launch: ZcodeAppServerLaunch
  closeCount: number
}

export type FakeConnectionRoutes = Partial<{
  'session/create': (params: Record<string, unknown>) => unknown
  'session/resume': (params: Record<string, unknown>) => unknown
  'session/send': (params: Record<string, unknown>) => unknown
  'session/stop': (params: Record<string, unknown>) => unknown
}>

export function fakeZcode(routes: FakeConnectionRoutes = {}) {
  const connections: FakeConnection[] = []
  const openConnection: typeof openZcodeAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      requests: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: (method, params, options) => {
        connection.requests.push({ method, params })
        const payload = readParams(params)
        const route = readRoute(routes, method)
        const settle = route
          ? route(payload)
          : method === 'session/create'
            ? {
                session: { sessionId: PROVIDER_SESSION },
                messages: []
              }
            : method === 'session/resume'
              ? {
                  session: { sessionId: payload.sessionId },
                  messages: [
                    {
                      info: { role: 'user', messageId: 'm1' },
                      parts: [{ type: 'text', text: 'earlier' }]
                    },
                    {
                      info: { role: 'assistant', messageId: 'm2' },
                      parts: [{ type: 'text', text: 'answer' }]
                    }
                  ]
                }
              : method === 'session/subscribe'
                ? { sessionId: payload.sessionId, eventSeq: 0, events: [] }
                : {}
        const timeoutMs = options?.timeoutMs
        if (timeoutMs === undefined) {
          return Promise.resolve(settle)
        }
        // The real connection owns per-request deadlines; the fake mirrors that.
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`fake zcode ${method} exceeded ${timeoutMs}ms`)),
            timeoutMs
          )
          Promise.resolve(settle).then(
            (result) => {
              clearTimeout(timer)
              resolve(result)
            },
            (error: unknown) => {
              clearTimeout(timer)
              reject(error)
            }
          )
        })
      },
      notify: () => {},
      respond: (id, result) => {
        connection.replies.push({ id, result })
      },
      respondWithError: (id, code, message) => {
        connection.replies.push({ id, result: { code, message } })
      },
      pauseReading: () => {},
      resumeReading: () => {},
      close: async () => {
        connection.closeCount += 1
        connection.handlers.onExit?.(new Error('zcode app-server connection closed'), {
          expected: true
        })
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  return { connections, openConnection }
}

export type ZcodeAcquireArgs = {
  identity: {
    sessionId: string
    workspaceId: string
    hostId: string
    agent: 'zcode'
    providerHandle: null
  }
  fence: number
  spawnToken: string
}

export function identityFor(sessionId = 'session-1'): ZcodeAcquireArgs['identity'] {
  return {
    sessionId,
    workspaceId: 'worktree-1',
    hostId: 'local',
    agent: 'zcode',
    providerHandle: null
  }
}

/** The adapter's `ended` event, as the wire carries it (subset the tests assert on). */
export type RecordedEndEvent = {
  type: 'ended'
  sessionId: string
  reason: string
  cause: string
  fence: number
  acquisitionGeneration: string
  observedAt?: number
}

export function adapterFor(
  zcode: ReturnType<typeof fakeZcode>,
  events: RecordedEndEvent[] = [],
  deps: Partial<ZcodeStructuredSessionAdapterDeps> = {}
): ZcodeStructuredSessionAdapter {
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'zcode',
      args: ['app-server', '--stdio'],
      cwd: '/work/repo',
      zcodeHome: '/home/dev/.zcode',
      resumeSessionId: null,
      workspacePath: '/work/repo'
    }),
    onEvent: (event) => events.push(event),
    openConnection: zcode.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    mintAcquisitionGeneration: () => `generation-${zcode.connections.length}`,
    ...deps
  })
}

export const acquireInput = (overrides: Partial<ZcodeAcquireArgs> = {}) => ({
  identity: identityFor(),
  fence: 7,
  spawnToken: 'spawn-9',
  ...overrides
})

export const zcodeSnapshot = (sessionId: string, messages: unknown[]) => ({
  session: { sessionId },
  messages
})

/** Narrows a request's params record without an assertion. */
function readParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? params : {}
}

/** The route for a method, when the test installed one. */
function readRoute(
  routes: FakeConnectionRoutes,
  method: string
): ((params: Record<string, unknown>) => unknown) | undefined {
  if (method === 'session/create') {
    return routes['session/create']
  }
  if (method === 'session/resume') {
    return routes['session/resume']
  }
  if (method === 'session/send') {
    return routes['session/send']
  }
  if (method === 'session/stop') {
    return routes['session/stop']
  }
  return undefined
}

export function expectEndEvent(
  events: {
    type: 'ended'
    sessionId: string
    reason: string
    cause: string
    fence: number
    acquisitionGeneration: string
    observedAt?: number
  }[],
  sessionId: string,
  cause: string
): void {
  expect(events).toEqual([expect.objectContaining({ type: 'ended', sessionId, cause })])
}

export type { ZcodeAppServerConnection }
