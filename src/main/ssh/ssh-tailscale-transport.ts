import type { Socket as NetSocket } from 'net'
import { dialThroughSocks5, type TailscaleSocksProxy } from './ssh-tailscale-dialer'

// Why: SshConnection should not know how the tailnet sidecar is started or where
// its SOCKS5 proxy lives. It depends on this narrow resolver; the concrete
// implementation (backed by the sidecar lifecycle client) is injected.
export type TailscaleTransportResolver = {
  /** Ensure the userspace tailnet sidecar is up and return its loopback SOCKS5
   *  proxy. Rejects if the tailnet is unavailable (sidecar down, not logged in). */
  resolveSocksProxy(): Promise<TailscaleSocksProxy>
}

/** Build the config.sock for a tailnet SSH target by dialing the destination
 *  through the sidecar's SOCKS5 proxy. Kept separate from SshConnection so the
 *  contract — fail clearly when the tailnet is unavailable, otherwise tunnel —
 *  is testable without standing up the full connection state machine. */
export async function resolveTailscaleSock(
  resolver: TailscaleTransportResolver | undefined,
  host: string,
  port: number,
  timeoutMs: number
): Promise<NetSocket> {
  if (!resolver) {
    throw new Error(
      'Tailscale transport is unavailable: the tailnet sidecar is not configured for this connection'
    )
  }
  const proxy = await resolver.resolveSocksProxy()
  return dialThroughSocks5(proxy, host, port, { timeoutMs })
}
