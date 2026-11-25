import { assertPortNotShadowingListener } from '../../runtime/rpc/transports/websocket/shadowed-port-probe'

// Loopback answers at once on POSIX; Windows retries a refused SYN for seconds, which also means nothing listens.
const IPV6_LOOPBACK_PROBE_TIMEOUT_MS = 150

/** User forwards listen on 127.0.0.1 only; a browser tries [::1] first for localhost, so a server there would answer instead. */
export function assertIpv6LoopbackPortFree(localPort: number): Promise<void> {
  return assertPortNotShadowingListener('::1', localPort, IPV6_LOOPBACK_PROBE_TIMEOUT_MS)
}
