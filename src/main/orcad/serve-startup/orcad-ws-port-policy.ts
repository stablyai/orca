import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-managed-launch-env'
import { DEFAULT_WS_PORT } from '../../runtime/rpc/server/runtime-rpc-pairing-types'
import { wsFallbackPortLadder } from '../../runtime/rpc/transports/websocket/ws-fallback-port-store'

type OrcadWsPortOptions = {
  wsPort?: number
  preferPinnedWsPort?: boolean
  requirePinnedWsPort?: boolean
}

/** First port past the desktop runtime's default and its whole fallback ladder. */
export const MANAGED_ORCAD_PREFERRED_WS_PORT =
  Math.max(...wsFallbackPortLadder(DEFAULT_WS_PORT)) + 1

/** Honor explicit ports; managed launches permit fallback because WSL distros share loopback. */
export function orcadWsPortOptions(
  port: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): OrcadWsPortOptions {
  if (port === undefined) {
    return {}
  }
  if (!env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]) {
    return { wsPort: port, preferPinnedWsPort: true, requirePinnedWsPort: true }
  }
  // Clients follow a managed server's published port, but desktop pairings and tunnels are pinned to
  // the desktop's ports; an orcad started while the desktop is closed must not keep them (#41799).
  const desktopPort = port >= DEFAULT_WS_PORT && port < MANAGED_ORCAD_PREFERRED_WS_PORT
  return { wsPort: desktopPort ? MANAGED_ORCAD_PREFERRED_WS_PORT : port, preferPinnedWsPort: true }
}
