import { BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES } from '../../../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelConnectionCredit } from './browser-network-tunnel-connection-credit'
import { browserNetworkTunnelMaxPendingChunks } from './browser-network-tunnel-stream-state'

type PendingWrite = {
  bytes: Uint8Array<ArrayBufferLike>
  offset: number
  callback: (error?: Error | null) => void
  releaseApplicationBytes: () => void
}

export type BrowserNetworkTunnelSourceFlowStream = {
  id: number
  windowBytes: number
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
    stream.pendingWriteBytes + bytes.byteLength > stream.windowBytes ||
    stream.pendingWrites.length >= browserNetworkTunnelMaxPendingChunks(stream.windowBytes)
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
  connection: Pick<
    BrowserNetworkTunnelConnectionCredit,
    'sendableBytes' | 'spend' | 'waitForSendCredit'
  >,
  resumeFlush: () => void,
  sendData: (bytes: Uint8Array<ArrayBufferLike>) => boolean
): boolean {
  while (stream.sendCredit > 0 && stream.pendingWrites.length > 0) {
    const pending = stream.pendingWrites[0]!
    if (pending.offset === pending.bytes.byteLength) {
      // An empty write carries nothing, so it never waits for credit.
      stream.pendingWrites.shift()
      pending.releaseApplicationBytes()
      pending.callback()
      continue
    }
    const length = connection.sendableBytes(
      Math.min(
        pending.bytes.byteLength - pending.offset,
        stream.sendCredit,
        BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES
      )
    )
    if (length === 0) {
      connection.waitForSendCredit(stream.id, resumeFlush)
      return true
    }
    // Spend first: the peer may acknowledge synchronously, and a rejected send closes the tunnel.
    connection.spend(length)
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
