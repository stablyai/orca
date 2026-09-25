/**
 * The address `orcad` binds its RPC listener to.
 *
 * Why loopback by default: the desktop stays on loopback until the user pairs, and the
 * shipping design reaches a remote orcad over an SSH local port-forward — so the wide
 * bind orcad had was both a departure from the desktop's posture and unnecessary for the
 * deploy model. Exposure is now something an operator asks for by name.
 */
import { isIP } from 'node:net'

export const ORCAD_LOOPBACK_BIND_HOST = '127.0.0.1'
const ALL_INTERFACES_V4 = '0.0.0.0'
const ALL_INTERFACES_V6 = '::'

export class OrcadBindAddressError extends Error {
  readonly code = 'orcad_invalid_bind_address'
}

/**
 * Resolve `--bind`. Literal IPs only.
 *
 * Why not hostnames: `listen()` resolves a name through DNS, so the interface actually
 * bound is decided by resolver configuration this process cannot see. An operator who
 * writes `--bind internal.example` would have no way to know whether the service came up
 * on a private interface or a public one.
 */
export function resolveOrcadBindHost(raw?: string): string {
  if (raw === undefined) {
    return ORCAD_LOOPBACK_BIND_HOST
  }
  const value = raw.trim()
  if (value === '') {
    throw new OrcadBindAddressError('--bind expects an address')
  }
  if (value === 'localhost') {
    return ORCAD_LOOPBACK_BIND_HOST
  }
  if (isIP(value) === 0) {
    throw new OrcadBindAddressError(
      `--bind expects a literal IP address (got '${value}'). Hostnames are refused because ` +
        'DNS decides which interface would be bound. Use 127.0.0.1 for loopback, or ' +
        '0.0.0.0 to expose every interface.'
    )
  }
  return value
}

/** True when this address reaches beyond the local machine. */
export function bindHostIsNetworkExposed(host: string): boolean {
  if (host === ALL_INTERFACES_V4 || host === ALL_INTERFACES_V6) {
    return true
  }
  if (isIP(host) === 4) {
    return !host.startsWith('127.')
  }
  return host !== '::1'
}

/** One line for the startup log, so an exposed deployment is never a silent default. */
export function describeOrcadBindExposure(host: string): string {
  return bindHostIsNetworkExposed(host)
    ? `orcad is bound to ${host} and is reachable from the network. Anything that can reach ` +
        'this port can attempt pairing.'
    : `orcad is bound to ${host} (local only). Reach it from another machine with an SSH ` +
        'local port-forward, or re-launch with --bind to expose it.'
}
