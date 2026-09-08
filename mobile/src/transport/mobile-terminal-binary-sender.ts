import { encryptBytes } from './e2ee'
import { encodeTerminalStreamFrame, type TerminalStreamFrame } from './terminal-stream-protocol'

export function sendMobileTerminalBinaryFrame(args: {
  frame: TerminalStreamFrame
  socket: WebSocket | null
  sharedKey: Uint8Array | null
  isConnected: boolean
  onSocketClosed: (socket: WebSocket) => void
}): boolean {
  if (!args.socket || args.socket.readyState !== WebSocket.OPEN || !args.sharedKey) {
    return false
  }
  try {
    args.socket.send(encryptBytes(encodeTerminalStreamFrame(args.frame), args.sharedKey))
    return true
  } catch {
    if (args.isConnected) {
      args.onSocketClosed(args.socket)
    }
    return false
  }
}
