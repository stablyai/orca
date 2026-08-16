import { BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES } from '../../shared/browser-network-tunnel-protocol'
import {
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
} from './browser-network-tunnel-stream-state'

type PendingWrite = {
  bytes: Uint8Array<ArrayBufferLike>
  offset: number
  callback: (error?: Error | null) => void
  releaseApplicationBytes: () => void
}

export type BrowserNetworkTunnelSourceFlowStream = {
  sendCredit: number
  pendingWrites: PendingWrite[]
  pendingWriteBytes: number
}

export function queueBrowserNetworkSourceWrite(
  stream: BrowserNetworkTunnelSourceFlowStream,
  bytes: Uint8Array<ArrayBufferLike>,
  callback: PendingWrite['callback'],
  claimApplicationBytes: (bytes: number) => (() => void) | null
): boolean {
  if (
    stream.pendingWriteBytes + bytes.byteLength > BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES ||
    stream.pendingWrites.length >= BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
  ) {
    return false
  }
  const releaseApplicationBytes = claimApplicationBytes(bytes.byteLength)
  if (!releaseApplicationBytes) {
    return false
  }
  const copy = bytes.slice()
  stream.pendingWrites.push({ bytes: copy, offset: 0, callback, releaseApplicationBytes })
  stream.pendingWriteBytes += copy.byteLength
  return true
}

export function flushBrowserNetworkSourceWrites(
  stream: BrowserNetworkTunnelSourceFlowStream,
  sendData: (bytes: Uint8Array<ArrayBufferLike>) => boolean
): boolean {
  while (stream.sendCredit > 0 && stream.pendingWrites.length > 0) {
    const pending = stream.pendingWrites[0]!
    const length = Math.min(
      pending.bytes.byteLength - pending.offset,
      stream.sendCredit,
      BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES
    )
    if (!sendData(pending.bytes.subarray(pending.offset, pending.offset + length))) {
      return false
    }
    pending.offset += length
    stream.sendCredit -= length
    stream.pendingWriteBytes -= length
    if (pending.offset === pending.bytes.byteLength) {
      stream.pendingWrites.shift()
      pending.releaseApplicationBytes()
      pending.callback()
    }
  }
  return true
}
