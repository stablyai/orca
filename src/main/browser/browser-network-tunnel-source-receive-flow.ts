import {
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
} from './browser-network-tunnel-stream-state'

export type BrowserNetworkTunnelSourceReceiveStream = {
  opened: boolean
  remoteEnded: boolean
  readableEnded: boolean
  receiveCredit: number
  pendingToSocket: Uint8Array<ArrayBufferLike>[]
  pendingToSocketBytes: number
  readableDemand: boolean
  socket: { push: (bytes: Buffer | null) => boolean }
}

export function queueBrowserNetworkSourceData(
  stream: BrowserNetworkTunnelSourceReceiveStream,
  payload: Uint8Array<ArrayBufferLike>
): boolean {
  if (
    !stream.opened ||
    stream.remoteEnded ||
    payload.byteLength === 0 ||
    payload.byteLength > stream.receiveCredit ||
    stream.pendingToSocketBytes + payload.byteLength >
      BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES ||
    stream.pendingToSocket.length >= BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
  ) {
    return false
  }
  stream.receiveCredit -= payload.byteLength
  stream.pendingToSocket.push(payload.slice())
  stream.pendingToSocketBytes += payload.byteLength
  flushBrowserNetworkSourceData(stream)
  return true
}

export function beginBrowserNetworkSourceRead(
  stream: BrowserNetworkTunnelSourceReceiveStream
): void {
  stream.readableDemand = true
  flushBrowserNetworkSourceData(stream)
}

export function grantBrowserNetworkSourceReceiveCredit(
  stream: BrowserNetworkTunnelSourceReceiveStream,
  bytes: number,
  maxCredit: number
): boolean {
  if (stream.receiveCredit + bytes > maxCredit) {
    return false
  }
  stream.receiveCredit += bytes
  return true
}

export function finishBrowserNetworkSourceData(
  stream: BrowserNetworkTunnelSourceReceiveStream
): boolean {
  if (stream.remoteEnded) {
    return false
  }
  stream.remoteEnded = true
  flushBrowserNetworkSourceData(stream)
  return true
}

function flushBrowserNetworkSourceData(stream: BrowserNetworkTunnelSourceReceiveStream): void {
  while (stream.readableDemand && stream.pendingToSocket.length > 0) {
    const bytes = stream.pendingToSocket.shift()!
    stream.pendingToSocketBytes -= bytes.byteLength
    if (!stream.socket.push(Buffer.from(bytes))) {
      stream.readableDemand = false
    }
  }
  if (stream.remoteEnded && stream.pendingToSocket.length === 0 && !stream.readableEnded) {
    stream.readableEnded = true
    stream.socket.push(null)
  }
}
