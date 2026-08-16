import { connect } from 'node:net'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

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

export function browserNetworkExecutionHostKey(host: BrowserNetworkExecutionHost): string {
  if (host.kind === 'native') {
    return JSON.stringify(['native', host.runtimeId, host.revision])
  }
  return JSON.stringify(['ssh', host.targetId, host.providerEpoch, host.connectionGeneration])
}

export function resolveNativeBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext
): BrowserNetworkExecutionRoute {
  const host = context.executionHost
  if (
    host.kind !== 'native' ||
    host.runtimeId !== context.runtimeId ||
    host.revision !== context.runtimeRevision
  ) {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  return {
    key: browserNetworkExecutionHostKey(host),
    connect: (target) => connect({ ...target, allowHalfOpen: true }),
    isValid: () => true,
    close: () => {}
  }
}
