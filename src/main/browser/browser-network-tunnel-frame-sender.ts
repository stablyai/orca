import {
  encodeBrowserNetworkTunnelFrame,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSessionOptions } from './browser-network-tunnel-stream-state'

export function sendBrowserNetworkTunnelFrame(
  sendBinary: BrowserNetworkTunnelSessionOptions['sendBinary'],
  frame: BrowserNetworkTunnelFrame
): boolean {
  try {
    return sendBinary(encodeBrowserNetworkTunnelFrame(frame))
  } catch {
    return false
  }
}
