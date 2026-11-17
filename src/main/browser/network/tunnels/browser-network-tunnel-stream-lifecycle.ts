import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

export function createBrowserNetworkTunnelStream(options: {
  id: number
  socket: BrowserNetworkTunnelSocket
  windowBytes: number
  earlyData: boolean
  onConnectTimeout: (stream: BrowserNetworkTunnelStream) => void
}): BrowserNetworkTunnelStream {
  const stream: BrowserNetworkTunnelStream = {
    id: options.id,
    socket: options.socket,
    windowBytes: options.windowBytes,
    receiveWindowBytes: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    connected: false,
    closed: false,
    // Early data is the only credit a client holds before Opened grants the rest of the window.
    receiveCredit: options.earlyData
      ? BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES
      : BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    sendCredit: 0,
    pendingToClient: [],
    pendingToClientBytes: 0,
    pendingDestinationWriteReleases: new Set(),
    earlyData: options.earlyData,
    heldDestinationWrites: [],
    clientEnded: false,
    destinationEnded: false,
    destinationClosed: false,
    destinationHalfCloseSent: false,
    connectTimeout: setTimeout(
      () => options.onConnectTimeout(stream),
      BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    )
  }
  return stream
}

export function retireBrowserNetworkTunnelStream(
  stream: BrowserNetworkTunnelStream,
  releaseRetainedBytes: (bytes: number) => void
): void {
  if (stream.closed) {
    return
  }
  stream.closed = true
  clearTimeout(stream.connectTimeout)
  for (const release of stream.pendingDestinationWriteReleases) {
    release()
  }
  releaseRetainedBytes(stream.pendingToClientBytes)
  stream.pendingToClient = []
  stream.pendingToClientBytes = 0
  // Early data for a destination that never connected is dropped, never delivered later.
  stream.heldDestinationWrites = []
  stream.socket.destroy()
}
