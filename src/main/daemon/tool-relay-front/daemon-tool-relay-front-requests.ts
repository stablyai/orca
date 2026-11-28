import type { Socket } from 'node:net'
import type { ConnectedDaemonClient } from '../server/daemon-client-connections'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import {
  TOOL_RELAY_FRONT_EVENT,
  TOOL_RELAY_FRONT_REQUEST_TYPES,
  type ToolRelayFrontConnectionEvent,
  type ToolRelayFrontEventPayload,
  type ToolRelayFrontOpenResult,
  type ToolRelayFrontServeResult
} from '../protocol/daemon-tool-relay-front-protocol'
import { streamFramesFor } from '../transport/framing/daemon-stream-data-split'
import type { DaemonToolRelayFront } from './daemon-tool-relay-front'

/** Past this much unread on the app's stream, front notices wait for it to drain. */
export const MAX_UNREAD_STREAM_BYTES = 1024 * 1024

/** Undefined leaves every other request to the router. */
export function answerToolRelayFrontRequest(
  request: DaemonRequest,
  client: ConnectedDaemonClient | undefined,
  socket: Socket,
  front: DaemonToolRelayFront | null
): Promise<ToolRelayFrontOpenResult | ToolRelayFrontServeResult | object> | undefined {
  if (!TOOL_RELAY_FRONT_REQUEST_TYPES.has(request.type)) {
    return undefined
  }
  if (!client?.authenticatedPairEstablished || client.controlSocket !== socket || !front) {
    return Promise.reject(new Error('Tool relay front unavailable'))
  }
  const { daemonInstance } = front
  if (request.type === 'toolRelayFrontOpen') {
    return front.open().then((port) => ({ port, daemonInstance }))
  }
  if (request.type === 'toolRelayFrontRevoke') {
    const owner = jsonProperty(jsonProperty(request, 'payload'), 'owner')
    if (typeof owner !== 'string') {
      return Promise.reject(new Error('Invalid tool relay revoke'))
    }
    front.kept.revoke(owner)
    return Promise.resolve({})
  }
  const port = front.serve(client.clientId, socket, noticesTo(client, front))
  // Only to this authenticated control connection: the tokens of the agents this start keeps.
  return Promise.resolve({ port, daemonInstance, kept: front.kept.list() })
}

/**
 * The serving app's notices, written to its stream. While it has more than the bound unread, they
 * wait instead, bounded: the held connections not yet announced (only those still held), and one
 * mark for any relay ends, sent on drain as `keptChanged` so the app serves again and reconciles.
 */
function noticesTo(
  client: ConnectedDaemonClient,
  front: DaemonToolRelayFront
): (payload: ToolRelayFrontEventPayload) => void {
  const waitingHeld = new Set<string>()
  let keptChanged = false
  let draining = false
  const write = (payload: ToolRelayFrontEventPayload): void => {
    const event: ToolRelayFrontConnectionEvent = {
      type: 'event',
      event: TOOL_RELAY_FRONT_EVENT,
      sessionId: 'tool-relay-front',
      payload
    }
    client.streamSocket?.write(streamFramesFor(client.streamFraming).control(event))
  }
  const flush = (): void => {
    draining = false
    for (const frontConnectionId of waitingHeld) {
      if (front.holds(frontConnectionId)) {
        write({ frontConnectionId })
      }
    }
    waitingHeld.clear()
    if (keptChanged) {
      keptChanged = false
      write({ keptChanged: true })
    }
  }
  return (payload) => {
    const stream = client.streamSocket
    if (!stream || stream.destroyed) {
      return
    }
    if (stream.writableLength <= MAX_UNREAD_STREAM_BYTES) {
      write(payload)
      return
    }
    for (const frontConnectionId of waitingHeld) {
      if (!front.holds(frontConnectionId)) {
        waitingHeld.delete(frontConnectionId)
      }
    }
    if ('frontConnectionId' in payload) {
      waitingHeld.add(payload.frontConnectionId)
    } else {
      keptChanged = true
    }
    if (!draining) {
      draining = true
      stream.once('drain', flush)
    }
  }
}
