import {
  BrowserNetworkTunnelOpcode,
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

export class BrowserNetworkTunnelFrameSender {
  constructor(
    private readonly tunnelGeneration: number,
    private readonly sendBinary: BrowserNetworkTunnelSessionOptions['sendBinary'],
    private readonly onRejected?: () => void,
    private readonly canSend?: () => boolean
  ) {}

  send(
    opcode: BrowserNetworkTunnelOpcode,
    streamId: number,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): boolean {
    if (this.canSend && !this.canSend()) {
      return false
    }
    const accepted = sendBrowserNetworkTunnelFrame(this.sendBinary, {
      opcode,
      tunnelGeneration: this.tunnelGeneration,
      streamId,
      payload
    })
    if (!accepted) {
      this.onRejected?.()
    }
    return accepted
  }

  sendError(streamId: number, code: string): boolean {
    return this.send(BrowserNetworkTunnelOpcode.Error, streamId, new TextEncoder().encode(code))
  }
}
