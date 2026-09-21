export const BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES = 256 * 1024
export const BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS = 10_000
export const BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES = 256 * 1024
export const BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS = 256
export const BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS = 65_536

export function validateBrowserNetworkTunnelGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffff_ffff) {
    throw new Error('Browser tunnel generation is invalid')
  }
}

export function reserveBrowserNetworkTunnelStreamId(
  openedStreamIds: Set<number>,
  streamId: number
): 'stream_id_reused' | 'stream_id_budget_exhausted' | null {
  if (openedStreamIds.has(streamId)) {
    return 'stream_id_reused'
  }
  if (openedStreamIds.size >= BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS) {
    return 'stream_id_budget_exhausted'
  }
  openedStreamIds.add(streamId)
  return null
}

export type BrowserNetworkTunnelSocket = {
  destroyed: boolean
  setNoDelay(noDelay?: boolean): BrowserNetworkTunnelSocket
  pause(): BrowserNetworkTunnelSocket
  resume(): BrowserNetworkTunnelSocket
  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean
  end(): BrowserNetworkTunnelSocket
  destroy(): BrowserNetworkTunnelSocket
  on(event: 'connect', listener: () => void): BrowserNetworkTunnelSocket
  on(
    event: 'data',
    listener: (bytes: Uint8Array<ArrayBufferLike>) => void
  ): BrowserNetworkTunnelSocket
  on(event: 'end' | 'close', listener: () => void): BrowserNetworkTunnelSocket
  on(event: 'error', listener: (error: Error) => void): BrowserNetworkTunnelSocket
}

export type BrowserNetworkTunnelStream = {
  id: number
  socket: BrowserNetworkTunnelSocket
  connected: boolean
  releasePendingOpen: () => void
  closed: boolean
  receiveCredit: number
  sendCredit: number
  pendingToClient: Uint8Array<ArrayBufferLike>[]
  pendingToClientBytes: number
  pendingDestinationWriteReleases: Set<() => void>
  clientEnded: boolean
  destinationEnded: boolean
  destinationClosed: boolean
  destinationHalfCloseSent: boolean
  connectTimeout: ReturnType<typeof setTimeout>
}

export type BrowserNetworkTunnelSessionOptions = {
  tunnelGeneration: number
  connect: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  onClose?: () => void
  now?: () => number
  claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null
}
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
