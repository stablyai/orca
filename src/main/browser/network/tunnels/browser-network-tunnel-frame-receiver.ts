import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelConnectionCredit } from './browser-network-tunnel-connection-credit'
import type { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'
import { handleBrowserNetworkTunnelHeartbeat } from './browser-network-tunnel-heartbeat'

export type BrowserNetworkTunnelFrameReceiver = {
  tunnelGeneration: number
  frameSender: BrowserNetworkTunnelFrameSender
  connectionCredit: BrowserNetworkTunnelConnectionCredit
  dispatch: (frame: BrowserNetworkTunnelFrame) => void
  fail: (error: Error) => void
}

/** Decodes a peer frame, consumes connection-scoped frames, and dispatches the rest to streams. */
export function receiveBrowserNetworkTunnelFrame(
  bytes: Uint8Array<ArrayBufferLike>,
  receiver: BrowserNetworkTunnelFrameReceiver
): void {
  const frame = decodeBrowserNetworkTunnelFrame(bytes)
  if (!frame) {
    receiver.fail(new Error('Browser tunnel received an invalid frame'))
    return
  }
  if (
    frame.tunnelGeneration !== receiver.tunnelGeneration ||
    handleBrowserNetworkTunnelHeartbeat(frame, receiver.frameSender)
  ) {
    return
  }
  if (frame.streamId === 0) {
    const acknowledged = decodeBrowserNetworkTunnelWindowUpdate(frame.payload)
    if (!acknowledged || !receiver.connectionCredit.acknowledge(acknowledged)) {
      receiver.fail(new Error('Browser tunnel received invalid connection credit'))
    }
    return
  }
  if (frame.opcode !== BrowserNetworkTunnelOpcode.Data) {
    receiver.dispatch(frame)
    return
  }
  // Counted before stream lookup so data racing a retirement still returns its credit.
  const acknowledged = receiver.connectionCredit.receive(frame.streamId, frame.payload.byteLength)
  if (acknowledged === null) {
    receiver.fail(new Error('Browser tunnel connection window exceeded'))
    return
  }
  // Acknowledge after dispatch so a synchronous peer cannot reorder its next Data frame ahead.
  receiver.dispatch(frame)
  if (acknowledged > 0) {
    receiver.frameSender.send(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      0,
      encodeBrowserNetworkTunnelWindowUpdate(acknowledged)
    )
  }
}
