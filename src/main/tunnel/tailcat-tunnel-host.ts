import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { setRemoteRuntimeTunnelDialer } from '../../shared/remote-runtime-tunnel-dialer'
import type { TailcatTunnelService } from './tailcat-tunnel-service'
import { getTailcatTunnelService } from './tailcat-tunnel-dialer-registration'

export { disposeTailcatTunnel, getTailcatTunnelService } from './tailcat-tunnel-dialer-registration'

/**
 * Hooks the tunnel into a started RPC server: offers can embed the token, remote dials go through
 * tailcat, and a host that already handed out tunnel links brings the tunnel back up on launch.
 */
export async function attachTailcatTunnel(
  rpc: OrcaRuntimeRpcServer,
  userDataPath: string,
  options: { startServer?: boolean } = {}
): Promise<TailcatTunnelService> {
  const tunnel = getTailcatTunnelService(userDataPath)
  rpc.setTunnelAdvertiser(tunnel)
  setRemoteRuntimeTunnelDialer(tunnel.dial)
  const port = boundWebSocketPort(rpc)
  if (port !== null && (options.startServer || rpc.hasTunnelGrants())) {
    try {
      await tunnel.ensureServer(port)
    } catch (error) {
      // Why: a missing or failing tailcat must not block the runtime; the offer reports it when asked.
      console.error('[tunnel] Tailcat tunnel did not start:', error)
    }
  }
  return tunnel
}

export function boundWebSocketPort(rpc: OrcaRuntimeRpcServer): number | null {
  const endpoint = rpc.getWebSocketEndpoint()
  if (!endpoint) {
    return null
  }
  const port = Number(new URL(endpoint).port)
  return Number.isInteger(port) && port > 0 ? port : null
}
