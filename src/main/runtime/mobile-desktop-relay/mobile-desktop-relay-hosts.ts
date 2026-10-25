import type { ManagedOrcadDeploymentSummary } from '../../../shared/managed-orcad-execution-host'
import type { PairingOffer } from '../../../shared/pairing'
import type { RuntimeEnvironmentSource } from '../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { SshConnectionState } from '../../../shared/ssh-types'

/** A configured server the desktop can relay to. */
export type MobileDesktopRelayHost = {
  environmentId: string
  // Pairing revision and runtime identity; delegated grants from another fence are never reused.
  fence: string
  // The desktop's own runtime-scope pairing; the relay swaps in a phone's delegated token.
  pairing: PairingOffer
}

/** A configured server as the desktop's sidebar sees it, without contacting it. */
export type MobileDesktopRelayHostListing = {
  id: string
  name: string
  source?: RuntimeEnvironmentSource
  orcadDeployment?: ManagedOrcadDeploymentSummary | null
  pairingRevision: number
  runtimeId: string | null
  /** The desktop's own device id on that server, as pairing recorded it. */
  pairedDeviceId?: string
}

/** Bounds a call; `expected` refuses it once the server was re-paired or its runtime changed. */
export type MobileDesktopRelayCallOptions = {
  timeoutMs?: number
  expected?: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

/** The desktop's configured servers, as the relay sees them. */
export type MobileDesktopRelayHosts = {
  /**
   * Every configured server, with the desktop's own last status for those it has one for, and its
   * SSH targets, which pair a managed server with the SSH host it runs on.
   */
  list: () => {
    environments: MobileDesktopRelayHostListing[]
    statusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
    sshTargetLabels: ReadonlyMap<string, string>
    sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  }
  /** Null when the id names no configured server; a phone-supplied endpoint is never used. */
  resolve: (environmentId: string) => Promise<MobileDesktopRelayHost | null>
  /** A call as the desktop itself, over its own connection to the server. */
  call: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    method: string,
    params: unknown,
    options?: MobileDesktopRelayCallOptions
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Whether this desktop renders the page itself as a client-placed page of that server. */
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
  /** Fires when a server is removed, re-paired or disconnected; returns an unsubscribe. */
  onEnvironmentRetired: (listener: (environmentId: string) => void) => () => void
  /** Fires whenever the desktop republishes a server's status; returns an unsubscribe. */
  onStatusChanged: (listener: () => void) => () => void
  /**
   * The server's own workspace change events as the desktop itself, needing no window. `onChange`
   * fires once the stream is ready, on `worktreesChanged`/`reposChanged`, and on a replay after a
   * reconnect, which may have missed events; `onClose` when the stream ends. `catalog` is false
   * only for `worktreesChanged`, which no repo or project-group write sends alone.
   */
  watchChanges: (
    host: Pick<MobileDesktopRelayHost, 'environmentId'>,
    expected: NonNullable<MobileDesktopRelayCallOptions['expected']>,
    callbacks: { onChange: (change: { catalog: boolean }) => void; onClose: () => void }
  ) => MobileDesktopRelayHostWatch
}

export type MobileDesktopRelayHostWatch = {
  close: () => void
  /** False once closed, ended, or its transport was replaced, which can end it without `onClose`. */
  current: () => boolean
}
