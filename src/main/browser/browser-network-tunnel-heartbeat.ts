import {
  BrowserNetworkTunnelOpcode,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'

export function handleBrowserNetworkTunnelHeartbeat(
  frame: BrowserNetworkTunnelFrame,
  sender: Pick<BrowserNetworkTunnelFrameSender, 'send'>
): boolean {
  if (frame.opcode === BrowserNetworkTunnelOpcode.Ping) {
    sender.send(BrowserNetworkTunnelOpcode.Pong, frame.streamId, frame.payload)
    return true
  }
  return frame.opcode === BrowserNetworkTunnelOpcode.Pong
}
