import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { createBridgeHostFrames } from './bridge-host-frames'
import { BridgeReplyUndeliverableError } from './bridge-host-errors'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'

type BridgeHostFrames = ReturnType<typeof createBridgeHostFrames>

export function createBridgeHostReplySender(
  sendJson: BridgeHostFrames['sendJson'],
  sendError: BridgeHostFrames['sendError']
) {
  return function sendReply(id: string, payload: RpcResponse): void {
    const split = splitBridgeReply(id, payload)
    if (!split.ok) {
      sendError(id, new BridgeReplyUndeliverableError(split.refusal))
      return
    }
    for (const frame of split.frames) {
      sendJson(frame)
    }
  }
}
