import { assertPortNotShadowingListener } from '../../runtime/rpc/transports/websocket/shadowed-port-probe'

// Loopback answers at once on POSIX; Windows retries a refused SYN for seconds, which also means nothing listens.
const IPV6_LOOPBACK_PROBE_TIMEOUT_MS = 150

/** Throws EADDRINUSE when a local server answers on [::1]:`localPort`, where a browser tries localhost first. */
export function assertIpv6LoopbackPortFree(localPort: number): Promise<void> {
  return assertPortNotShadowingListener('::1', localPort, IPV6_LOOPBACK_PROBE_TIMEOUT_MS)
}
