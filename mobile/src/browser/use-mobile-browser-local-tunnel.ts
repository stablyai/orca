import { useEffect, useState } from 'react'
import {
  MOBILE_BROWSER_TUNNEL_METHOD,
  type MobileBrowserTunnelEvent
} from '../../../src/shared/mobile-browser-tunnel-protocol'
import { OrcaProxiedBrowser } from '../../modules/orca-proxied-browser/src'
import type { RpcClient } from '../transport/rpc-client'
import { bridgeProxiedBrowserToTunnel, proxiedBrowserStoreId } from './mobile-browser-local-proxy'
import { MobileBrowserTunnelClient } from './mobile-browser-tunnel-client'

export type MobileBrowserLocalTunnel =
  // This phone, app build or connection cannot draw pages itself; stream them instead.
  | { status: 'unavailable' }
  | { status: 'starting' }
  | { status: 'ready'; proxyKey: string; storeId: string }
  | { status: 'failed'; message: string }

function tunnelEvent(
  result: unknown
): MobileBrowserTunnelEvent | { type: 'error'; message: string } | null {
  if (!result || typeof result !== 'object' || !('type' in result)) {
    return null
  }
  if (result.type === 'error') {
    const message = 'message' in result && typeof result.message === 'string' ? result.message : ''
    return { type: 'error', message }
  }
  if (!('tunnelGeneration' in result) || typeof result.tunnelGeneration !== 'number') {
    return null
  }
  if (result.type === 'closed') {
    return { type: 'closed', tunnelGeneration: result.tunnelGeneration }
  }
  if (
    result.type === 'ready' &&
    'subscriptionId' in result &&
    typeof result.subscriptionId === 'string'
  ) {
    return {
      type: 'ready',
      tunnelGeneration: result.tunnelGeneration,
      subscriptionId: result.subscriptionId
    }
  }
  return null
}

export function canRenderBrowserLocally(client: RpcClient | null): boolean {
  return !!client?.browserTunnel && OrcaProxiedBrowser?.isSupported() === true
}

// Each mounted pane gets its own proxy: proxy events carry only the key, so two bridges on one key would both answer
// one connection. Cookies stay per host through the store id.
let lastProxyInstance = 0

// The host holds one tunnel per connection and frees it a moment after the phone lets go, so a pane that takes over
// from another (full screen, a network switch) asks again briefly instead of failing.
const TUNNEL_BUSY = 'binary_handler_mode_conflict'
const TUNNEL_BUSY_RETRY_MS = 250
const TUNNEL_BUSY_RETRIES = 8

/** Runs a proxy and tunnel to this host while a local browser pane is mounted. */
export function useMobileBrowserLocalTunnel(
  client: RpcClient | null,
  hostId: string,
  workspaceId: string,
  enabled: boolean
): MobileBrowserLocalTunnel {
  const [state, setState] = useState<MobileBrowserLocalTunnel>({ status: 'starting' })
  const [busyRetries, setBusyRetries] = useState(0)
  const supported = enabled && canRenderBrowserLocally(client)

  useEffect(() => {
    const channel = client?.browserTunnel
    const native = OrcaProxiedBrowser
    if (!supported || !client || !channel || !native) {
      setState({ status: 'unavailable' })
      return
    }
    setState({ status: 'starting' })
    const proxyKey = `${hostId}#${++lastProxyInstance}`
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopBridge = (): void => {}
    const tunnel = new MobileBrowserTunnelClient({
      channel,
      subscribe: (onEvent) =>
        client.subscribe(MOBILE_BROWSER_TUNNEL_METHOD, { workspaceId }, (result) => {
          const event = tunnelEvent(result)
          if (
            event?.type === 'error' &&
            event.message === TUNNEL_BUSY &&
            busyRetries < TUNNEL_BUSY_RETRIES
          ) {
            retry ??= setTimeout(() => setBusyRetries((count) => count + 1), TUNNEL_BUSY_RETRY_MS)
          } else if (event?.type === 'error') {
            setState({ status: 'failed', message: event.message })
          } else if (event) {
            onEvent(event)
          }
        }),
      onClosed: () => setState({ status: 'failed', message: 'the host closed the tunnel' })
    })
    native
      .startProxy(proxyKey)
      .then(() => {
        if (disposed) {
          void native.stopProxy(proxyKey)
          return
        }
        stopBridge = bridgeProxiedBrowserToTunnel(native, proxyKey, tunnel).stop
        setState((current) =>
          current.status === 'failed'
            ? current
            : { status: 'ready', proxyKey, storeId: proxiedBrowserStoreId(hostId) }
        )
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setState({
            status: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      disposed = true
      clearTimeout(retry)
      stopBridge()
      tunnel.close()
      void native.stopProxy(proxyKey)
    }
  }, [client, hostId, workspaceId, supported, busyRetries])

  return state
}
