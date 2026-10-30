import type { ManagedOrcadDeploymentSummary } from '../../../shared/managed-orcad-execution-host'
import type { PairingOffer } from '../../../shared/pairing'
import type { RuntimeEnvironmentSource } from '../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../shared/ssh-types'

export type MobileDesktopRelayHost = {
  environmentId: string
  // Pairing revision and runtime identity; delegated grants from another fence are never reused.
  fence: string
  // The desktop's own runtime-scope pairing; the relay swaps in a phone's delegated token.
  pairing: PairingOffer
}

/** Desktop sidebar view of a configured server, without contacting it. */
export type MobileDesktopRelayHostListing = {
  id: string
  name: string
  source?: RuntimeEnvironmentSource
  orcadDeployment?: ManagedOrcadDeploymentSummary | null
  pairingRevision: number
  runtimeId: string | null
  /** The desktop's own device id on that server, as pairing recorded it. */
  pairedDeviceId?: string
  /** This desktop's own WSL host, confirmed stopped: only the desktop may start it. */
  stoppedOnDesktop?: true
  /** This desktop's own WSL host, not connected here (yet unconfirmed stopped). */
  unavailableOnDesktop?: true
}

/** Bound calls and reject stale pairing/runtime identity via expected. */
export type MobileDesktopRelayCallOptions = {
  timeoutMs?: number
  expected?: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

export type MobileDesktopRelayHosts = {
  /** Last-known server statuses and SSH targets identifying their underlying hosts. */
  list: () => {
    environments: MobileDesktopRelayHostListing[]
    statusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
    sshTargetLabels: ReadonlyMap<string, string>
    sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  }
  /** Null when the id names no configured server; a phone-supplied endpoint is never used. */
  resolve: (environmentId: string) => Promise<MobileDesktopRelayHost | null>
  call: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    method: string,
    params: unknown,
    options?: MobileDesktopRelayCallOptions
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Whether this desktop renders the page itself as a client-placed page of that server. */
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
  onEnvironmentRetired: (listener: (environmentId: string) => void) => () => void
  onStatusChanged: (listener: () => void) => () => void
  /** Windowless server events: onChange fires on ready, catalog changes and reconnect replay.
   * catalog is false only for worktreesChanged; repo/project-group writes never emit that event alone. */
  watchChanges: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    expected: NonNullable<MobileDesktopRelayCallOptions['expected']>,
    callbacks: { onChange: (change: { catalog: boolean }) => void; onClose: () => void }
  ) => MobileDesktopRelayHostWatch
}

export type MobileDesktopRelayHostWatch = {
  close: () => void
  /** False after close, stream end or transport replacement, even without onClose. */
  current: () => boolean
}
