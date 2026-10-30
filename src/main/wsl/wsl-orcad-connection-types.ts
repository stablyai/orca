import type { PairingOffer } from '../../shared/pairing'
import type { OrcadTunnelIdentity } from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import type {
  WslOrcadDeferredUpdate,
  WslOrcadDeployOptions,
  WslOrcadLaunch
} from './wsl-orcad-deploy'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import type { WslOrcadPairingRecovery } from './wsl-orcad-pairing-identity'
import type { WslOrcadStdioBridgeOptions } from './wsl-orcad-stdio-bridge'

/** One open bridge to a distro's orcad, as the connection manager publishes it. */
export type WslOrcadConnection = {
  distro: string
  environmentId: string
  /** The loopback port on this machine the pairing offer points at. */
  localPort: number
  /** orcad's port inside the distro. */
  remotePort: number
  fullVersion: string
  /** orcad's pid inside the distro, from its pid file; null when unreadable. */
  pid: number | null
  /** orcad's pairing code, with its endpoint rewritten to `ws://127.0.0.1:<localPort>`. */
  pairingOffer: string
  /** An app update the incumbent `fullVersion` is waiting to take (live terminals). */
  deferredUpdate: WslOrcadDeferredUpdate | null
  close(): Promise<void>
}

export type WslOrcadConnectionDependencies = {
  holder?: WslDistroHolder
  getPairingOffer?: (environmentId: string) => PairingOffer | null
  /** The bridge port the host's record saved: rebinding it keeps the pairing across app restarts. */
  recordedLocalPort?: (environmentId: string) => number | null
  deployAndLaunch?: (distro: string, options: WslOrcadDeployOptions) => Promise<WslOrcadLaunch>
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport
  listen?: (
    transport: OrcadHostTransport,
    options: WslOrcadStdioBridgeOptions
  ) => Promise<StartedPortForward>
  verifyIdentity?: (pairingOffer: string, readiness: ServeReadiness) => Promise<OrcadTunnelIdentity>
  /** Re-pairs a refused enrolled token; without it a refusal fails the connect. */
  pairingRecovery?: Omit<WslOrcadPairingRecovery, 'environmentId'>
  /** A connection (re)opened, its offer changed, or its status moved; null once it closed. */
  onChange?: (
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ) => void
}
