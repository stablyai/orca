/**
 * The desktop's only way into a WSL distro's orcad (design D2): a loopback listener whose every
 * accepted socket rides its own `wsl.exe` child running the stdio bridge on the distro's pinned
 * Node. WSL localhost forwarding is never used: it refuses connections for 0.2–1 s after a listen
 * and depends on the distro's networking mode.
 */
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  ORCAD_STDIO_BRIDGE_DEPENDENCIES,
  startOrcadStdioBridge,
  type OrcadStdioBridgeDependencies
} from '../managed-server/lifecycle/orcad-stdio-bridge-provider'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { OrcadStdioBridgeSparePolicy } from '../managed-server/lifecycle/orcad-stdio-bridge-spares'

// Each bridge child costs a wsl.exe start (~0.2-0.3 s on a slow PC); a connect's first calls dial
// four sockets in a row, so two spares cover that burst. No steady-state children past the window.
const WSL_BRIDGE_SPARES: OrcadStdioBridgeSparePolicy = { spares: 2, windowMs: 20_000 }

export type WslOrcadStdioBridgeOptions = {
  environmentId: string
  /** orcad's loopback port inside the distro. */
  remotePort: number
  /** 0 picks a free one. */
  localPort: number
  label: string
  /** Bridge children opened ahead of the connect's first dials; absent opens one per socket. */
  spares?: OrcadStdioBridgeSparePolicy
}

export function listenWslOrcadStdioBridge(
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions,
  dependencies: OrcadStdioBridgeDependencies = ORCAD_STDIO_BRIDGE_DEPENDENCIES
): Promise<StartedPortForward> {
  return startOrcadStdioBridge(
    transport,
    {
      id: `wsl-orcad:${options.environmentId}`,
      connectionId: options.environmentId,
      localHost: '127.0.0.1',
      localPort: options.localPort,
      remoteHost: '127.0.0.1',
      remotePort: options.remotePort,
      label: options.label
    },
    dependencies,
    options.spares
  )
}

type WslOrcadStdioBridgeListen = (
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions
) => Promise<StartedPortForward>

/** A persisted local port may be taken by now; a free one beats no connection. */
export async function listenWslOrcadStdioBridgeOnPreferredPort(
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions,
  listen: WslOrcadStdioBridgeListen = listenWslOrcadStdioBridge
): Promise<StartedPortForward> {
  options = { spares: WSL_BRIDGE_SPARES, ...options }
  try {
    return await listen(transport, options)
  } catch (error) {
    if (options.localPort === 0) {
      throw error
    }
    console.warn(
      `[wsl] Could not rebind local port ${options.localPort}; picking another:`,
      error instanceof Error ? error.message : error
    )
    return listen(transport, { ...options, localPort: 0 })
  }
}
