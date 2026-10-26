/** D2: each accepted loopback socket owns a pinned-Node wsl.exe stdio bridge. Avoid WSL localhost forwarding, whose startup refusal window and network-mode dependence make it unreliable. */
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  ORCAD_STDIO_BRIDGE_DEPENDENCIES,
  startOrcadStdioBridge,
  type OrcadStdioBridgeDependencies
} from '../managed-server/lifecycle/orcad-stdio-bridge-provider'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'

export type WslOrcadStdioBridgeOptions = {
  environmentId: string
  /** orcad's loopback port inside the distro. */
  remotePort: number
  /** 0 picks a free one. */
  localPort: number
  label: string
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
    dependencies
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
