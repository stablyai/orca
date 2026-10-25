import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { buildDirectRpcWireRequest, type RpcRequestFrame } from './rpc-envelope-fields'

export const DIRECT_WIRE_DEVICE_TOKEN = 'device-token'

export type DirectWire = ReturnType<typeof directWire>

/** What the direct client writes to its socket, through the same builder it uses. */
export function directWire() {
  const sent: string[] = []
  let counter = 0
  return {
    sent,
    frames: () => sent.map((json) => JSON.parse(json)),
    nextId: () => `rpc-${++counter}`,
    sendFrame: (frame: RpcRequestFrame) => {
      sent.push(JSON.stringify(buildDirectRpcWireRequest(frame, DIRECT_WIRE_DEVICE_TOKEN)))
      return true
    }
  }
}

export function directWireTracker(socket: DirectWire): RpcClientRequestTracker {
  return new RpcClientRequestTracker({
    nextId: socket.nextId,
    getState: () => 'connected',
    waitForConnected: async () => undefined,
    sendFrame: socket.sendFrame
  })
}

export function directWireRegistry(socket: DirectWire): RpcClientStreamRegistry {
  return new RpcClientStreamRegistry({
    nextId: socket.nextId,
    getState: () => 'connected',
    sendFrame: socket.sendFrame
  })
}
