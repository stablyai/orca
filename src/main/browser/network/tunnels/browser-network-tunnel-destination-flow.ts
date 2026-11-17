import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  decodeBrowserNetworkTunnelWindowUpdate
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelConnectionCredit } from './browser-network-tunnel-connection-credit'
import {
  BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES,
  browserNetworkTunnelMaxPendingChunks,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

export const BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW = 'route_buffer_overflow'
export const BROWSER_NETWORK_TUNNEL_EARLY_DATA_CHUNK_OVERFLOW = 'early_data_chunk_overflow'
// A request arrives in a few frames; a peer slicing its early data finer fails only its stream.
const MAX_HELD_DESTINATION_WRITES = 256

type BrowserNetworkTunnelDestinationFlowActions = {
  isCurrent: () => boolean
  connection: Pick<
    BrowserNetworkTunnelConnectionCredit,
    'sendableBytes' | 'spend' | 'waitForSendCredit'
  >
  resumeFlush: () => void
  sendData: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendHalfClose: () => void
  finalizeClose: () => void
  releaseRetainedBytes: (bytes: number) => void
}

export function halfCloseBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream
): string | null {
  if ((!stream.connected && !stream.earlyData) || stream.clientEnded) {
    return 'invalid_client_half_close'
  }
  stream.clientEnded = true
  // Before connect, the end follows the held early data once the destination connects.
  if (stream.connected) {
    stream.socket.end()
  }
  return null
}

export function writeBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream,
  payload: Uint8Array<ArrayBufferLike>,
  onSettled: (bytes: number) => void,
  claimRetainedBytes: (bytes: number) => (() => void) | null
): string | null {
  if ((!stream.connected && !stream.earlyData) || stream.clientEnded) {
    return 'invalid_client_data'
  }
  if (payload.byteLength > stream.receiveCredit) {
    return 'receive_window_exceeded'
  }
  if (payload.byteLength === 0) {
    return null
  }
  if (!stream.connected && stream.heldDestinationWrites.length >= MAX_HELD_DESTINATION_WRITES) {
    return BROWSER_NETWORK_TUNNEL_EARLY_DATA_CHUNK_OVERFLOW
  }
  if (
    stream.pendingDestinationWriteReleases.size >=
    browserNetworkTunnelMaxPendingChunks(stream.windowBytes)
  ) {
    return 'destination_write_chunk_overflow'
  }
  const releaseClaim = claimRetainedBytes(payload.byteLength)
  if (!releaseClaim) {
    return BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW
  }
  stream.receiveCredit -= payload.byteLength
  const bytes = payload.slice()
  let retained = true
  const release = (): void => {
    if (!retained) {
      return
    }
    retained = false
    stream.pendingDestinationWriteReleases.delete(release)
    releaseClaim()
  }
  stream.pendingDestinationWriteReleases.add(release)
  const done = (): void => {
    release()
    onSettled(bytes.byteLength)
  }
  // Early data stays retained (and its credit unreturned) until the destination connects.
  if (stream.connected) {
    stream.socket.write(bytes, done)
  } else {
    stream.heldDestinationWrites.push({ bytes, done })
  }
  return null
}

/** Valid peer credit can exceed the retained pool: these failures end only their stream. */
export function isStreamScopedDestinationFailure(code: string): boolean {
  return (
    code === BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW ||
    code === BROWSER_NETWORK_TUNNEL_EARLY_DATA_CHUNK_OVERFLOW
  )
}

/**
 * Marks the destination connected and returns the credit Opened grants: the whole initial window,
 * or with early data, writes the held bytes (then a held half-close) in the order the client sent
 * them and tops its early credit up to the initial window.
 */
export function connectBrowserNetworkDestination(stream: BrowserNetworkTunnelStream): number {
  stream.connected = true
  clearTimeout(stream.connectTimeout)
  if (!stream.earlyData) {
    return stream.receiveWindowBytes
  }
  const held = stream.heldDestinationWrites
  stream.heldDestinationWrites = []
  for (const write of held) {
    stream.socket.write(write.bytes, write.done)
  }
  if (stream.clientEnded) {
    stream.socket.end()
  }
  const topUp = Math.max(0, stream.receiveWindowBytes - BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES)
  stream.receiveCredit += topUp
  return topUp
}

export function grantBrowserNetworkDestinationCredit(
  stream: BrowserNetworkTunnelStream,
  payload: Uint8Array<ArrayBufferLike>
): string | null {
  if (!stream.connected && !stream.earlyData) {
    return 'invalid_client_credit'
  }
  const credit = decodeBrowserNetworkTunnelWindowUpdate(payload)
  if (!credit || stream.sendCredit + credit > stream.windowBytes) {
    return 'send_window_overflow'
  }
  stream.sendCredit += credit
  return null
}

export function queueBrowserNetworkDestinationData(
  stream: BrowserNetworkTunnelStream,
  bytes: Uint8Array<ArrayBufferLike>
): string | null {
  if (!stream.connected || stream.destinationEnded || stream.destinationClosed) {
    return 'invalid_destination_data'
  }
  if (
    stream.pendingToClientBytes + bytes.byteLength > stream.windowBytes ||
    stream.pendingToClient.length >= browserNetworkTunnelMaxPendingChunks(stream.windowBytes)
  ) {
    return 'destination_buffer_overflow'
  }
  stream.pendingToClient.push(bytes.slice())
  stream.pendingToClientBytes += bytes.byteLength
  return null
}

export function flushBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream,
  actions: BrowserNetworkTunnelDestinationFlowActions
): void {
  while (stream.sendCredit > 0 && stream.pendingToClient.length > 0 && actions.isCurrent()) {
    const next = stream.pendingToClient[0]!
    const length = actions.connection.sendableBytes(
      Math.min(next.byteLength, stream.sendCredit, BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES)
    )
    if (length === 0) {
      actions.connection.waitForSendCredit(stream.id, actions.resumeFlush)
      break
    }
    // Spend first: the peer may acknowledge synchronously, and a rejected send closes the tunnel.
    actions.connection.spend(length)
    if (!actions.sendData(next.subarray(0, length))) {
      return
    }
    if (!actions.isCurrent()) {
      return
    }
    stream.sendCredit -= length
    stream.pendingToClientBytes -= length
    actions.releaseRetainedBytes(length)
    if (length === next.byteLength) {
      stream.pendingToClient.shift()
    } else {
      stream.pendingToClient[0] = next.slice(length)
    }
  }
  if (!actions.isCurrent()) {
    return
  }
  if (stream.pendingToClient.length > 0) {
    stream.socket.pause()
    return
  }
  if (stream.destinationEnded) {
    actions.sendHalfClose()
    if (!stream.destinationClosed) {
      return
    }
  }
  if (stream.destinationClosed) {
    actions.finalizeClose()
  } else if (stream.sendCredit === 0) {
    stream.socket.pause()
  } else {
    stream.socket.resume()
  }
}
