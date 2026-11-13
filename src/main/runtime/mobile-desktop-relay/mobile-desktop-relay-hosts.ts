import type { ManagedOrcadDeploymentSummary } from '../../../shared/execution-host/managed-orcad-execution-host'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RuntimeEnvironmentSource } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { BrowserPageCreationPlacement } from '../../../shared/browser/client-hosting/browser-client-host-placement'

export type MobileDesktopRelayHost = {
  environmentId: string
  // Pairing revision and runtime identity; delegated grants from another fence are never reused.
  fence: string
  pairingRevision?: number
  /** Set when the opening request waited for a recipe VM wake that re-paired the server onto
   *  `pairingRevision`: a retirement for that re-pair does not end the link that asked for it. */
  wokenByOpening?: true
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
  signal?: AbortSignal
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
  /** `openingMethod`: the request that needs the server, which may wake a recipe VM behind it. */
  resolve: (
    environmentId: string,
    openingMethod?: string,
    signal?: AbortSignal
  ) => Promise<MobileDesktopRelayHost | null>
  /** Where a recipe VM behind this server stands, for a request that opens a workspace. */
  serverStateForOpening?: (environmentId: string) => 'up' | 'waking' | 'asleep'
  /** How many times the user has disconnected this server: a link still preparing when it changes
   *  must not open, even if something reconnected the server since. */
  userDisconnects?: (environmentId: string) => number
  call: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    method: string,
    params: unknown,
    options?: MobileDesktopRelayCallOptions
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Whether this desktop renders the page itself as a client-placed page of that server. */
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
  /** Active desktop browser host, used only after the delegated phone is admitted on the server. */
  browserHostClientId?: (environmentId: string) => string | null
  prepareBrowserHost?: (
    host: MobileDesktopRelayHost,
    enabled: boolean
  ) => Promise<BrowserPageCreationPlacement>
  onEnvironmentRetired: (listener: (environmentId: string) => void) => () => void
  onStatusChanged: (listener: () => void) => () => void
  /** The saved server list was edited (added, renamed, removed), here or by the CLI. */
  onCatalogChanged?: (listener: () => void) => () => void
  /** Windowless server events: onChange fires on ready, catalog and agent row changes, and reconnect replay.
   * catalog is false for worktreesChanged and worktreeRowsChanged; repo/project-group writes never emit those alone.
   * live marks ready and replay: events before it may have been missed. */
  watchChanges: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    expected: NonNullable<MobileDesktopRelayCallOptions['expected']>,
    callbacks: {
      onChange: (change: { catalog: boolean; live?: true }) => void
      onClose: () => void
    }
  ) => MobileDesktopRelayHostWatch
}

export type MobileDesktopRelayHostWatch = {
  close: () => void
  /** False after close, stream end or transport replacement, even without onClose. */
  current: () => boolean
}
