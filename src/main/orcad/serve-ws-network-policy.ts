import { resolve } from 'node:path'
import type { RuntimeWsNetworkPolicy } from '../runtime/rpc/ws-transport-network-guard'
import { parseAllowedClientRanges } from '../runtime/rpc/ws-client-address-policy'
import { bindHostIsNetworkExposed, resolveOrcadBindHost } from './orcad-bind-address'
import { WS_BIND_HOST_ALL_INTERFACES } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import type { OrcadOptions } from './orcad-start-contract'

/** Why the lockout follows exposure: a loopback-only host has no remote peer to lock out. */
export function serveWsNetworkPolicy(
  options: Pick<OrcadOptions, 'allowIp' | 'tlsCert' | 'tlsKey'>,
  bindHost: string
): RuntimeWsNetworkPolicy {
  return {
    ...(options.tlsCert && options.tlsKey
      ? {
          tls: {
            certPath: resolve(options.tlsCert),
            keyPath: resolve(options.tlsKey)
          }
        }
      : {}),
    ...(options.allowIp ? { allowedClients: parseAllowedClientRanges(options.allowIp) } : {}),
    limitUnauthenticatedClients: bindHostIsNetworkExposed(bindHost)
  }
}

/** Electron `--serve` parity: the same flags, on a listener that otherwise binds every interface. */
export function electronServeNetworkOptions(options: {
  bind?: string | null
  allowIp?: string | null
  tlsCert?: string | null
  tlsKey?: string | null
}): { pinnedBindHost?: string; wsNetworkPolicy: RuntimeWsNetworkPolicy } {
  const bindHost = options.bind ? resolveOrcadBindHost(options.bind) : WS_BIND_HOST_ALL_INTERFACES
  return {
    ...(options.bind ? { pinnedBindHost: bindHost } : {}),
    wsNetworkPolicy: serveWsNetworkPolicy(
      {
        ...(options.allowIp ? { allowIp: options.allowIp } : {}),
        ...(options.tlsCert ? { tlsCert: options.tlsCert } : {}),
        ...(options.tlsKey ? { tlsKey: options.tlsKey } : {})
      },
      bindHost
    )
  }
}
