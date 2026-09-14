import {
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
} from './browser-network-tunnel-stream-state'

export type BrowserNetworkTunnelSourceReceiveStream = {
  opened: boolean
  remoteEnded: boolean
  readableEnded: boolean
  receiveCredit: number
  pendingToSocket: BrowserNetworkTunnelSourceData[]
  pendingToSocketBytes: number
  unsettledToSocket: BrowserNetworkTunnelSourceDataSettlement[]
  readableDemand: boolean
  socket: { push: (bytes: Buffer | null) => boolean }
}

type BrowserNetworkTunnelSourceData = {
  bytes: Uint8Array<ArrayBufferLike>
  releaseApplicationBytes: () => void
}

type BrowserNetworkTunnelSourceDataSettlement = {
  bytes: number
  releaseApplicationBytes: () => void
}

export function queueBrowserNetworkSourceData(
  stream: BrowserNetworkTunnelSourceReceiveStream,
  payload: Uint8Array<ArrayBufferLike>,
  claimApplicationBytes: (bytes: number) => (() => void) | null
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
  const releaseApplicationBytes = claimApplicationBytes(payload.byteLength)
  if (!releaseApplicationBytes) {
    return false
  }
  stream.receiveCredit -= payload.byteLength
  stream.pendingToSocket.push({ bytes: payload.slice(), releaseApplicationBytes })
  stream.pendingToSocketBytes += payload.byteLength
  flushBrowserNetworkSourceData(stream)
  return true
}

export function settleBrowserNetworkSourceData(
  stream: BrowserNetworkTunnelSourceReceiveStream,
  bytes: number
): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return false
  }
  let remaining = bytes
  while (remaining > 0) {
    const settlement = stream.unsettledToSocket[0]
    if (!settlement) {
      return false
    }
    const consumed = Math.min(remaining, settlement.bytes)
    settlement.bytes -= consumed
    remaining -= consumed
    if (settlement.bytes === 0) {
      stream.unsettledToSocket.shift()
      settlement.releaseApplicationBytes()
    }
  }
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
    const pending = stream.pendingToSocket.shift()!
    const bytes = pending.bytes
    stream.pendingToSocketBytes -= bytes.byteLength
    stream.unsettledToSocket.push({
      bytes: bytes.byteLength,
      releaseApplicationBytes: pending.releaseApplicationBytes
    })
    if (!stream.socket.push(Buffer.from(bytes))) {
      stream.readableDemand = false
    }
  }
  if (stream.remoteEnded && stream.pendingToSocket.length === 0 && !stream.readableEnded) {
    stream.readableEnded = true
    stream.socket.push(null)
  }
}
