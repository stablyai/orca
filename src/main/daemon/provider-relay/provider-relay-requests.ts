import type { Socket } from 'node:net'
import type { ConnectedDaemonClient } from '../server/daemon-client-connections'
import { NOTIFY_PREFIX, type DaemonRequest } from '../protocol/daemon-rpc-contract'
import {
  PROVIDER_RELAY_REQUEST_TYPES,
  RELAY_ACKS_MAX,
  type ProviderRelayRequest
} from '../protocol/daemon-provider-relay-protocol'
import { jsonObject } from '../../../shared/json-stream/json-value-property'
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
  const payload: Record<string, unknown> =
    'payload' in request && typeof request.payload === 'object' && request.payload !== null
      ? { ...request.payload }
      : {}
  const relayId = payload.relayId
  // Which daemon start answers, echoed so a client never reads it from a reconnect's newer hello.
  const instance = relays.daemonInstance ? { daemonInstance: relays.daemonInstance } : {}
  switch (request.type) {
    case 'relaySpawn':
      return relays
        .spawn(
          request.payload?.spec,
          request.payload?.chatKey,
          payload.policy,
          payload.agent,
          payload.keep
        )
        .then((spawned) => ('relayId' in spawned ? { ...spawned, ...instance } : spawned))
    case 'relayAttach':
      if (!client.streamSocket) {
        return Promise.reject(new Error('Daemon client connection is incomplete; reconnect'))
      }
      return relays.attach(
        clientId,
        { socket: client.streamSocket, framing: client.streamFraming },
        relayId,
        payload.fromSeq,
        payload.policy,
        payload.kept
      )
    case 'relayWrite':
      // A notification can't hear a refusal, so a refused write would vanish; only requests may write.
      if (request.id.startsWith(NOTIFY_PREFIX)) {
        return Promise.reject(new Error('relayWrite must be a request'))
      }
      relays.write(clientId, relayId, payload.data)
      return Promise.resolve({})
    case 'relayAck':
      return Promise.resolve(relays.ack(clientId, relayId, payload.seq, payload.keepFrom, payload))
    case 'relayAcks':
      return Promise.resolve(ackEach(relays, clientId, payload.acks))
    case 'relayClose':
      return relays.close(relayId, payload.grace).then(() => ({}))
    case 'relayList':
      return Promise.resolve({ ...relays.list(), ...instance })
    case 'relayDetach':
      return relays.detach(clientId, relayId, payload.policy).then(() => ({}))
  }
}

/** Each ack on its own: one refused (its relay gone or taken over) doesn't fail the rest. */
function ackEach(
  relays: ProviderRelayHost,
  clientId: string,
  acks: unknown
): { results: unknown[] } {
  if (!Array.isArray(acks) || acks.length > RELAY_ACKS_MAX) {
    throw new Error('Invalid relay acks')
  }
  return {
    results: acks.map((ack: unknown) => {
      const fields = jsonObject(ack) ?? {}
      try {
        return relays.ack(clientId, fields.relayId, fields.seq, fields.keepFrom, fields)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
  }
}
