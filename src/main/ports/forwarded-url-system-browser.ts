import type { PortForwardEntry } from '../../shared/remote-runtime/ssh/ssh-types'
import type { ForwardedUrlOpenRequest } from '../../shared/workspace/ports/forwarded-url-open'
import { connectionManager, portForwardManager } from '../ipc/ssh/ssh-ipc-context'
import { listPairedPortForwards } from './paired-forwards/paired-port-forwards'
import { holdsIpv6Loopback } from './paired-forwards/paired-port-forward-provider'
import { pairedForwardTunnel } from './paired-forwards/paired-port-forward-tunnels'
import { assertIpv6LoopbackPortFree } from '../ssh/port-forwarding/local-forward-ipv6-loopback-probe'

// An explicit :0 is no port at all; only an absent one means the scheme's default.
function urlPort(url: URL): number {
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
}

/** Teardown disposes a connection before its listeners finish closing; their entries reach nothing. */
function connectionUsable(request: ForwardedUrlOpenRequest): boolean {
  const connection =
    request.forwardKind === 'ssh'
      ? connectionManager?.getConnection(request.connectionId)
      : pairedForwardTunnel(request.connectionId)
  return connection !== undefined && connection !== null && !connection.isDisposed()
}

/** The forward still listed under the same mapping, on a connection that is not torn down. Whether
 *  it has bound yet is not checked: dialing it would open a remote stream on every click. */
function liveForward(request: ForwardedUrlOpenRequest): PortForwardEntry | undefined {
  if (!connectionUsable(request)) {
    return undefined
  }
  const forwards =
    request.forwardKind === 'ssh'
      ? (portForwardManager?.listForwards(request.connectionId) ?? [])
      : listPairedPortForwards(request.connectionId)
  return forwards.find(
    (forward) =>
      forward.id === request.forwardId &&
      forward.connectionId === request.connectionId &&
      forward.localPort === request.localPort &&
      forward.remoteHost === request.remoteHost &&
      forward.remotePort === request.remotePort
  )
}

/** The URL to hand the system browser for a forward's local port; null once that forward is gone or
 *  remapped. A browser tries [::1] first for localhost, so when the forward listens on 127.0.0.1 only
 *  and another local app answers [::1], this names 127.0.0.1, accepting the origin change. */
export async function systemBrowserUrlForForward(
  request: ForwardedUrlOpenRequest
): Promise<{ url: URL; movedToIpv4: boolean } | null> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    urlPort(url) !== request.localPort ||
    !liveForward(request)
  ) {
    return null
  }
  const hostname = url.hostname.toLowerCase()
  const ipv4Only = request.forwardKind === 'ssh' || !holdsIpv6Loopback(process.platform)
  if (!ipv4Only || (hostname !== 'localhost' && !hostname.endsWith('.localhost'))) {
    return { url, movedToIpv4: false }
  }
  const ipv6Answers = await assertIpv6LoopbackPortFree(request.localPort).then(
    () => false,
    () => true
  )
  // The forward can close or be edited while the probe waits.
  if (!liveForward(request)) {
    return null
  }
  if (!ipv6Answers) {
    return { url, movedToIpv4: false }
  }
  const ipv4 = new URL(url)
  ipv4.hostname = '127.0.0.1'
  return { url: ipv4, movedToIpv4: true }
}
