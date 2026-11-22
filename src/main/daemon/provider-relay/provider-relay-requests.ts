import type { Socket } from 'node:net'
import type { ConnectedDaemonClient } from '../server/daemon-client-connections'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import {
  PROVIDER_RELAY_REQUEST_TYPES,
  type ProviderRelayRequest
} from '../protocol/daemon-provider-relay-protocol'
import type { ProviderRelayHost } from './provider-relay-host'

function isRelayRequest(request: DaemonRequest): request is ProviderRelayRequest {
  return PROVIDER_RELAY_REQUEST_TYPES.has(request.type)
}

/** Undefined leaves every other request to the router. */
export function answerProviderRelayRequest(
  request: DaemonRequest,
  client: ConnectedDaemonClient | undefined,
  socket: Socket,
  relays: ProviderRelayHost
): Promise<unknown> | undefined {
  if (!isRelayRequest(request)) {
    return undefined
  }
  if (!client?.authenticatedPairEstablished || client.controlSocket !== socket) {
    return Promise.reject(new Error('Relay host unavailable'))
  }
  const { clientId } = client
  const payload = (request as { payload?: Record<string, unknown> }).payload ?? {}
  const relayId = payload.relayId as string
  switch (request.type) {
    case 'relaySpawn':
      return relays.spawn(request.payload?.spec, request.payload?.chatKey)
    case 'relayAttach':
      if (!client.streamSocket) {
        return Promise.reject(new Error('Daemon client connection is incomplete; reconnect'))
      }
      return relays.attach(
        clientId,
        { socket: client.streamSocket, framing: client.streamFraming },
        relayId,
        payload.fromSeq
      )
    case 'relayWrite':
      relays.write(clientId, relayId, payload.data)
      return Promise.resolve({})
    case 'relayAck':
      relays.ack(clientId, relayId, payload.seq)
      return Promise.resolve({})
    case 'relayClose':
      return relays.close(relayId, payload.grace).then(() => ({}))
    case 'relayList':
      return Promise.resolve(relays.list())
    case 'relayDetach':
      return relays.detach(clientId, relayId).then(() => ({}))
  }
}
