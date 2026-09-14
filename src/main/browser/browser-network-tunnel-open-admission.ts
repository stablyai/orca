import {
  decodeBrowserNetworkTunnelOpen,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelResourceBudget } from './browser-network-tunnel-resource-budget'
import { createBrowserNetworkTunnelStream } from './browser-network-tunnel-stream-lifecycle'
import {
  reserveBrowserNetworkTunnelStreamId,
  type BrowserNetworkTunnelSessionOptions,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

const BROWSER_NETWORK_TUNNEL_MAX_STREAMS = 128

type BrowserNetworkTunnelOpenAdmissionContext = {
  openedStreamIds: Set<number>
  streamCount: number
  resourceBudget: BrowserNetworkTunnelResourceBudget
  connect: BrowserNetworkTunnelSessionOptions['connect']
  sendError: (streamId: number, code: string) => void
  closeSession: () => void
  onConnectTimeout: (stream: BrowserNetworkTunnelStream) => void
}

// Returns null once the rejection has been reported; the caller only registers admitted streams.
export function admitBrowserNetworkTunnelOpen(
  frame: BrowserNetworkTunnelFrame,
  context: BrowserNetworkTunnelOpenAdmissionContext
): BrowserNetworkTunnelStream | null {
  const identityError = reserveBrowserNetworkTunnelStreamId(context.openedStreamIds, frame.streamId)
  if (identityError) {
    context.sendError(frame.streamId, identityError)
    context.closeSession()
    return null
  }
  if (!context.resourceBudget.admitOpenAttempt()) {
    context.sendError(frame.streamId, 'open_rate_exceeded')
    return null
  }
  if (context.streamCount >= BROWSER_NETWORK_TUNNEL_MAX_STREAMS) {
    context.sendError(frame.streamId, 'stream_limit_exceeded')
    return null
  }
  const target = decodeBrowserNetworkTunnelOpen(frame.payload)
  if (!target) {
    context.sendError(frame.streamId, 'invalid_open_target')
    return null
  }
  const releasePendingOpen = context.resourceBudget.claimPendingOpen()
  if (!releasePendingOpen) {
    context.sendError(frame.streamId, 'pending_open_limit_exceeded')
    return null
  }
  let socket: BrowserNetworkTunnelSocket
  try {
    socket = context.connect(target)
  } catch {
    releasePendingOpen()
    context.sendError(frame.streamId, 'destination_connect_failed')
    return null
  }
  return createBrowserNetworkTunnelStream({
    id: frame.streamId,
    socket,
    releasePendingOpen,
    onConnectTimeout: context.onConnectTimeout
  })
}
