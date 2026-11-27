import type { Socket } from 'node:net'
import type { ConnectedDaemonClient } from '../server/daemon-client-connections'
import type { DaemonRequest } from '../protocol/daemon-rpc-contract'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import {
  TOOL_RELAY_FRONT_EVENT,
  TOOL_RELAY_FRONT_REQUEST_TYPES,
  type ToolRelayFrontConnectionEvent,
  type ToolRelayFrontOpenResult,
  type ToolRelayFrontServeResult
} from '../protocol/daemon-tool-relay-front-protocol'
import { streamFramesFor } from '../transport/framing/daemon-stream-data-split'
import type { DaemonToolRelayFront } from './daemon-tool-relay-front'

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
  const port = front.serve(client.clientId, socket, (frontConnectionId) => {
    const stream = client.streamSocket
    if (!stream || stream.destroyed) {
      return
    }
    const event: ToolRelayFrontConnectionEvent = {
      type: 'event',
      event: TOOL_RELAY_FRONT_EVENT,
      sessionId: 'tool-relay-front',
      payload: { frontConnectionId }
    }
    stream.write(streamFramesFor(client.streamFraming).control(event))
  })
  // Only to this authenticated control connection: the tokens of the agents this start keeps.
  return Promise.resolve({ port, daemonInstance, kept: front.kept.list() })
}
