import type { ReadRunningWslDistros } from '../wsl/daemon-wsl-bridge-exit'
import type { WslBridgeBootIdentity } from '../wsl/daemon-wsl-bridge-boot-identity'

export type DaemonPtyAdapterOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  profileScope?: string
  protocolVersion?: number
  historyPath?: string
  runtimeDir?: string
  packagedAppVersion?: string | null
  respawn?: (reason: DaemonRespawnReason) => Promise<void | (() => void)>
  /** Test seam; production reads the shared, coalesced `wsl --list --running`. */
  readRunningWslDistros?: ReadRunningWslDistros
  /** Test seam; production reads each distro's boot id through the background-work gate. */
  wslBridgeBootIdentity?: WslBridgeBootIdentity
  /** Test seam; delays before each reconnect attempt to a dead daemon that cannot respawn. */
  preservedEndpointLossProbeDelaysMs?: readonly number[]
  /** Test seam; whether a preserved daemon's process is proven gone, given its last pid. */
  preservedDaemonExited?: (pid: number | undefined) => boolean
}

export type DaemonRespawnReason =
  | 'daemon_died'
  | 'unhealthy_resolver'
  | 'stale_bundle'
  | 'severed_tcc_attribution'
