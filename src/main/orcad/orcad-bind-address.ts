/**
 * The address `orcad` binds its RPC listener to.
 *
 * Why loopback by default: the desktop stays on loopback until the user pairs, and the
 * shipping design reaches a remote orcad over an SSH local port-forward — so the wide
 * bind orcad had was both a departure from the desktop's posture and unnecessary for the
 * deploy model. Exposure is now something an operator asks for by name.
 */
import { isIP } from 'node:net'

export {
  ORCAD_LOOPBACK_BIND_HOST,
  OrcadBindAddressError,
  resolveOrcadBindHost
} from '../../shared/runtime-bind-address'
const ALL_INTERFACES_V4 = '0.0.0.0'
const ALL_INTERFACES_V6 = '::'

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
