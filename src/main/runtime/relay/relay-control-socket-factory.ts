import WebSocket from 'ws'
import { remoteRuntimeConnectOptions } from '../../../shared/remote-runtime-connect-bound'
import { RELAY_HOST_CAPABILITY_HEADERS } from './relay-control-protocol'

/**
 * Builds the relay control socket with a transport-level connect bound.
 *
 * Why this exists separately from `connectDeadlineMs` in `RelayControlClient`:
 * that deadline bounds the whole handshake including the host proof, but it can
 * only run once the socket object exists, and it is the class's to arm. A
 * black-holed relay never opens and never errors, so the connect sub-phase
 * needs its own bound at the transport — the same one the remote-runtime
 * transports use. Both are kept deliberately: they cover different phases and
 * neither is redundant. See #18191.
 *
 * Keeping the construction here means a caller that reaches for the relay
 * control socket gets the bound, rather than re-deriving an unbounded one.
 */
export function createRelayControlSocket(
  url: string,
  relayJwt: string,
  connectBoundMs: number
): WebSocket {
  return new WebSocket(
    url,
    remoteRuntimeConnectOptions(
      {
        headers: { authorization: `Bearer ${relayJwt}`, ...RELAY_HOST_CAPABILITY_HEADERS },
        perMessageDeflate: false,
        maxPayload: 64 * 1024
      },
      connectBoundMs
    )
  )
}
