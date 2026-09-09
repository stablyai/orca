import { vi, type Mock } from 'vitest'

type MockRequestHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number; isStale: () => boolean }
) => Promise<unknown>
type MockNotificationHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number; isStale: () => boolean }
) => void
type MockCallContext = { clientId?: number; isStale: () => boolean }

// Explicit rather than inferred: vi.fn()'s inferred type is not nameable across project boundaries.
export type MockRelayFsDispatcher = {
  onRequest: Mock
  onNotification: Mock
  notify: Mock
  notifyClient: Mock
  onClientDetached: Mock
  _requestHandlers: Map<string, MockRequestHandler>
  _notificationHandlers: Map<string, MockNotificationHandler>
  _notifications: { method: string; params?: Record<string, unknown> }[]
  callRequest: (
    method: string,
    params?: Record<string, unknown>,
    context?: MockCallContext
  ) => Promise<unknown>
  callNotification: (
    method: string,
    params?: Record<string, unknown>,
    context?: { clientId: number; isStale: () => boolean }
  ) => void
  detachClient: (clientId: number) => void
}

/** Records handlers and notifications so a test can drive FsHandler without a real transport. */
export function createMockDispatcher(): MockRelayFsDispatcher {
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
