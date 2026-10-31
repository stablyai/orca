import type { WslBridgeBootIdentity } from './daemon-wsl-bridge-boot-identity'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { TakePendingOutputResult } from './types'
import type { HistoryCheckpointResult, HistoryRecoveryFreeze } from './history-manager'
import type { ReadRunningWslDistros } from './daemon-wsl-bridge-exit'
import type { DaemonPtyRouterExitEvent } from './daemon-pty-router-events'
export type PendingDaemonSpawnOperation = {
  exitsBySessionId: Map<string, Omit<DaemonPtyRouterExitEvent, 'id'>[]>
  ignoredExitIncarnationIds: Set<string>
  ignoreNextExit: boolean
}

export type HistoryRecoveryContext = {
  freeze: HistoryRecoveryFreeze | null
  unreadableSessionId: string | null
  identityChanged: boolean
}

export type SnapshotCheckpointResult = {
  checkpoint: HistoryCheckpointResult
  snapshot: NonNullable<TakePendingOutputResult['snapshot']> | null
}

export type DaemonPtyShutdownOptions = {
  immediate?: boolean
  keepHistory?: boolean
  deadlineMs?: number
  expectedIncarnationId?: string
}

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
}

export type DaemonRespawnReason =
  | 'daemon_died'
  | 'unhealthy_resolver'
  | 'stale_bundle'
  | 'severed_tcc_attribution'

export type DaemonIdentityChangeEvent = {
  previous: DaemonEndpointIdentity
  current: DaemonEndpointIdentity
}

export type DaemonIdleRetirementResult =
  | { state: 'retiring' }
  | { state: 'busy'; liveSessions: number | null; admissionReopened?: true }
  | { state: 'unsupported' }
  | { state: 'unverifiable' }
