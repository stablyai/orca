import { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import type { BrowserNetworkTunnelSourceFlowStream } from './browser-network-tunnel-source-flow'
import type { BrowserNetworkTunnelSourceReceiveStream } from './browser-network-tunnel-source-receive-flow'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
} from './browser-network-tunnel-stream-state'

export type BrowserNetworkTunnelClientStream = BrowserNetworkTunnelSourceFlowStream &
  BrowserNetworkTunnelSourceReceiveStream & {
    id: number
    socket: BrowserNetworkTunnelDuplex
    closed: boolean
    localEnded: boolean
    localHalfCloseSent: boolean
    remoteClosed: boolean
    connectTimeout: ReturnType<typeof setTimeout>
    resolveOpen: (socket: BrowserNetworkTunnelDuplex) => void
    rejectOpen: (error: Error) => void
  }

type BrowserNetworkTunnelClientStreamCallbacks = {
  writeBytes: (bytes: Uint8Array<ArrayBufferLike>, callback: (error?: Error | null) => void) => void
  requestRead: () => void
  consumeReadBytes: (bytes: number) => void
  finishWrite: (callback: (error?: Error | null) => void) => void
  destroyStream: (error: Error | null, callback: (error?: Error | null) => void) => void
  onConnectTimeout: (stream: BrowserNetworkTunnelClientStream) => void
}

export function createBrowserNetworkTunnelClientStream(
  id: number,
  callbacks: BrowserNetworkTunnelClientStreamCallbacks
): { stream: BrowserNetworkTunnelClientStream; opening: Promise<BrowserNetworkTunnelDuplex> } {
  let resolveOpen = (_socket: BrowserNetworkTunnelDuplex): void => {}
  let rejectOpen = (_error: Error): void => {}
  const opening = new Promise<BrowserNetworkTunnelDuplex>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const socket = new BrowserNetworkTunnelDuplex(callbacks)
  const stream: BrowserNetworkTunnelClientStream = {
    id,
    socket,
    opened: false,
    closed: false,
    localEnded: false,
    localHalfCloseSent: false,
    remoteEnded: false,
    remoteClosed: false,
    readableEnded: false,
    sendCredit: 0,
    receiveCredit: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    pendingToSocket: [],
    pendingToSocketBytes: 0,
    unsettledToSocket: [],
    readableDemand: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
    connectTimeout: setTimeout(
      () => callbacks.onConnectTimeout(stream),
      BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    ),
    resolveOpen,
    rejectOpen
  }
  return { stream, opening }
}
