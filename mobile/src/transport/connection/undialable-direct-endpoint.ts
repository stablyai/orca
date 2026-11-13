import { abortSignalReason } from '../../../../src/shared/abort-signal-reason'
import { isLinkLocalEndpoint } from '../../../../src/shared/network/link-local-address'
import type { HostProfile } from '../../host-catalog/host-profile'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { ConnectionState } from './connection-state'

// Older desktops could advertise an idle adapter's 169.254/fe80 address. It can never answer, so a
// relay-paired host skips it instead of redialing it on every reconnect; relay-less hosts keep
// dialing because the direct session is their only route to relay credentials.
export function skipsDirectEndpoint(host: Pick<HostProfile, 'endpoint' | 'relay'>): boolean {
  return host.relay !== undefined && isLinkLocalEndpoint(host.endpoint)
}

/**
 * Stands in for the direct session of a host whose endpoint is skipped. It never dials and stays
 * 'reconnecting' (the state a failed first dial leaves), so the endpoint supervisor recovers over
 * relay at once. Requests wait for the relay cutover exactly as they would on a reconnecting socket.
 */
export function createUndialableDirectClient(): RpcClient {
  let closed = false
  let state: ConnectionState = 'reconnecting'
  const waiters = new Set<(error: Error) => void>()
  const listeners = new Set<(next: ConnectionState) => void>()
  return {
    sendRequest(method, _params, options) {
      if (closed) {
        return Promise.reject(new Error('Client closed'))
      }
      const signal = options?.signal
      if (signal?.aborted) {
        return Promise.reject(abortSignalReason(signal))
      }
      if (options?.failWhenDisconnected) {
        return Promise.reject(new Error(`Not connected: ${method}`))
      }
      return new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          if (signal) {
            fail(abortSignalReason(signal))
          }
        }
        const fail = (error: Error): void => {
          waiters.delete(fail)
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
        const timer =
          options?.timeoutMs === undefined
            ? undefined
            : setTimeout(
                () => fail(new Error('Timed out while connecting to the remote Orca runtime.')),
                Math.max(0, options.timeoutMs)
              )
        waiters.add(fail)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notifyForeground: () => {},
    close() {
      if (closed) {
        return
      }
      closed = true
      state = 'disconnected'
      // Nothing reached a wire, so these are plain failures, not delivery-unknown.
      for (const fail of waiters) {
        fail(new Error('Client closed'))
      }
      for (const listener of listeners) {
        listener(state)
      }
    }
  }
}
