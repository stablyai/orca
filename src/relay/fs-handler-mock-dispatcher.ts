import { vi, type Mock } from 'vitest'

/** The in-memory dispatcher the FsHandler suites drive.
 *
 *  Lifted out of fs-handler.test.ts, which had reached its line budget: this
 *  harness is the largest thing in it, and the part more than one suite wants.
 */

type RequestHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number; isStale: () => boolean }
) => Promise<unknown>
type NotificationHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number; isStale: () => boolean }
) => void

/** Why spelled out rather than inferred: the inferred shape names a type
 *  internal to @vitest/spy, which TypeScript refuses to emit across a module
 *  boundary. */
export type MockRelayDispatcher = {
  onRequest: Mock
  onNotification: Mock
  notify: Mock
  notifyClient: Mock
  onClientDetached: Mock
  _requestHandlers: Map<string, RequestHandler>
  _notificationHandlers: Map<string, NotificationHandler>
  _notifications: { method: string; params?: Record<string, unknown> }[]
  callRequest: (
    method: string,
    params?: Record<string, unknown>,
    context?: { clientId?: number; isStale: () => boolean }
  ) => Promise<unknown>
  callNotification: (
    method: string,
    params?: Record<string, unknown>,
    context?: { clientId: number; isStale: () => boolean }
  ) => void
  detachClient: (clientId: number) => void
}

export function createMockDispatcher(): MockRelayDispatcher {
  const requestHandlers = new Map<
    string,
    (
      params: Record<string, unknown>,
      context?: { clientId: number; isStale: () => boolean }
    ) => Promise<unknown>
  >()
  const notificationHandlers = new Map<
    string,
    (
      params: Record<string, unknown>,
      context?: { clientId: number; isStale: () => boolean }
    ) => void
  >()
  const detachListeners = new Set<(clientId: number) => void>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  return {
    onRequest: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context?: { clientId: number; isStale: () => boolean }
        ) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context?: { clientId: number; isStale: () => boolean }
        ) => void
      ) => {
        notificationHandlers.set(method, handler)
      }
    ),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    notifyClient: vi.fn(),
    onClientDetached: vi.fn((listener: (clientId: number) => void) => {
      detachListeners.add(listener)
      return () => detachListeners.delete(listener)
    }),
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _notifications: notifications,
    async callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: { clientId?: number; isStale: () => boolean }
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, {
        clientId: context?.clientId ?? 1,
        isStale: context?.isStale ?? (() => false)
      })
    },
    callNotification(
      method: string,
      params: Record<string, unknown> = {},
      context?: { clientId: number; isStale: () => boolean }
    ) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params, context ?? { clientId: 1, isStale: () => false })
    },
    detachClient(clientId: number) {
      for (const listener of detachListeners) {
        listener(clientId)
      }
    }
  }
}
