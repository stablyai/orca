import type { BrowserNetworkExecutionHost } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../tunnels/browser-network-tunnel-stream-state'

export type BrowserNetworkExecutionRoute = {
  key: string
  connect: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket
  whenInvalidated?: Promise<void>
  isValid: () => boolean
  close: () => void | Promise<void>
}

export type BrowserNetworkExecutionRouteContext = {
  executionHost: BrowserNetworkExecutionHost
  runtimeId: string
  runtimeRevision: number
  signal?: AbortSignal
}

export type BrowserNetworkExecutionRouteResolver = (
  context: BrowserNetworkExecutionRouteContext
) => Promise<BrowserNetworkExecutionRoute>
