import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import type { ConnectionState } from './types'

/** The tracker and registry always share wiring; build them together. */
export function createDirectRequestPipeline(input: {
  deviceToken: string
  getState: () => ConnectionState
  waitForConnected: (timeoutMs?: number) => Promise<void>
  sendEncrypted: (request: unknown) => boolean
}): {
  requests: RpcClientRequestTracker
  streams: RpcClientStreamRegistry
  nextId: () => string
} {
  let requestCounter = 0
  const nextId = () => `rpc-${++requestCounter}-${Date.now()}`
  return {
    requests: new RpcClientRequestTracker({
      nextId,
      deviceToken: input.deviceToken,
      getState: input.getState,
      waitForConnected: input.waitForConnected,
      sendEncrypted: input.sendEncrypted
    }),
    streams: new RpcClientStreamRegistry({
      nextId,
      deviceToken: input.deviceToken,
      getState: input.getState,
      sendEncrypted: input.sendEncrypted
    }),
    nextId
  }
}
