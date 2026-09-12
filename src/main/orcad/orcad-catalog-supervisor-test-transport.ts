import { vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from '../../relay/dispatcher'
import type { RelayPtyOwnershipTransferAdapter } from '../../relay/relay-pty-ownership-transfer-adapter'
import { context } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'

export function installCatalogSupervisorTestTransport(source: RelayPtyOwnershipTransferAdapter) {
  const handlers = new Map<string, MethodHandler>()
  const notifications = new Map<string, (params: Record<string, unknown>) => void>()
  const detach = new Set<(clientId: number) => void>()
  source.register({
    onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
    onClientDetached: (listener: (clientId: number) => void) => {
      detach.add(listener)
      return () => detach.delete(listener)
    },
    onDisposed: () => () => {},
    onLegacyPtyCapacity: () => () => {},
    publishProducerNotification: (
      _clientId: number,
      method: string,
      params: Record<string, unknown>
    ) => {
      const listener = notifications.get(method)
      if (!listener) {
        return false
      }
      queueMicrotask(() => listener(params))
      return true
    }
  } as unknown as RelayDispatcher)
  const calls = vi.fn<SshChannelMultiplexer['request']>(async (method, params) => {
    const handler = handlers.get(method)
    if (!handler) {
      throw new Error(`unregistered test relay method: ${method}`)
    }
    return handler(params ?? {}, context())
  })
  vi.mocked(connectOrcadLocalRelay).mockImplementation(async (options) => {
    const listeners = new Set<(reason: string) => void>()
    let disposed = false
    const connection = {
      request: calls,
      onNotificationByMethod: (
        method: string,
        listener: (params: Record<string, unknown>) => void
      ) => {
        notifications.set(method, listener)
        return () => notifications.delete(method)
      },
      onDispose: (listener: (reason: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      dispose: () => {
        if (disposed) {
          return
        }
        disposed = true
        for (const listener of listeners) {
          listener('test_connection_disposed')
        }
        for (const listener of detach) {
          listener(context().clientId)
        }
      }
    } as unknown as SshChannelMultiplexer
    options.initialize(connection)
    return connection
  })
  return calls
}
