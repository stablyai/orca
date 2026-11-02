import {
  decodeBrowserNetworkTunnelOpen,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelResourceBudget } from './browser-network-tunnel-resource-budget'
import { createBrowserNetworkTunnelStream } from './browser-network-tunnel-stream-lifecycle'
import {
  BROWSER_NETWORK_TUNNEL_MAX_STREAMS,
  reserveBrowserNetworkTunnelStreamId,
  type BrowserNetworkTunnelSessionOptions,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

type BrowserNetworkTunnelOpenAdmissionContext = {
  openedStreamIds: Set<number>
  streamCount: number
  resourceBudget: BrowserNetworkTunnelResourceBudget
  connect: BrowserNetworkTunnelSessionOptions['connect']
  sendError: (streamId: number, code: string) => void
  closeSession: () => void
  onConnectTimeout: (stream: BrowserNetworkTunnelStream) => void
}

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
  let socket: BrowserNetworkTunnelSocket
  try {
    socket = context.connect(target)
  } catch {
    context.sendError(frame.streamId, 'destination_connect_failed')
    return null
  }
  return createBrowserNetworkTunnelStream({
    id: frame.streamId,
    socket,
    onConnectTimeout: context.onConnectTimeout
  })
}
