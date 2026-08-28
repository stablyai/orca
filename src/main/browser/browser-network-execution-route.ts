import { connect } from 'node:net'
import { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
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
  if (host.kind === 'wsl') {
    return JSON.stringify(['wsl', host.runtimeId, host.revision, host.distro])
  }
  return JSON.stringify(['ssh', host.targetId, host.providerEpoch, host.connectionGeneration])
}

export function parseBrowserNetworkExecutionHostKey(key: string): BrowserNetworkExecutionHost {
  let tuple: unknown
  try {
    tuple = JSON.parse(key)
  } catch {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  const candidate =
    Array.isArray(tuple) && tuple[0] === 'native' && tuple.length === 3
      ? { kind: 'native', runtimeId: tuple[1], revision: tuple[2] }
      : Array.isArray(tuple) && tuple[0] === 'wsl' && tuple.length === 4
        ? { kind: 'wsl', runtimeId: tuple[1], revision: tuple[2], distro: tuple[3] }
        : Array.isArray(tuple) && tuple[0] === 'ssh' && tuple.length === 4
          ? {
              kind: 'ssh',
              targetId: tuple[1],
              providerEpoch: tuple[2],
              connectionGeneration: tuple[3]
            }
          : null
  const parsed = BrowserNetworkExecutionHost.safeParse(candidate)
  if (!parsed.success || browserNetworkExecutionHostKey(parsed.data) !== key) {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  return parsed.data
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
