/** What the WSL host service drives: the C3 holder, C5 connections and C6 liveness, or an e2e fake. */
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectIntent } from './wsl-orcad-connection-status'

/** `stopped` and `unreachable` rest on a confirmed running list; `unavailable` could not read it. */
export type WslHostReachability = 'available' | 'unreachable' | 'stopped' | 'unavailable'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. An intent retries or forces a skipped update. */
  connect(distro: string, options?: WslOrcadConnectIntent): Promise<WslOrcadConnection>
  /** Explicit retry must clear pairing-repair failures and spent caps. */
  forgetPairingFailures?(environmentId: string): void
  get(distro: string): WslOrcadConnection | null
  /** Checks the paired server without starting a stopped or unconfirmed distro. */
  isReachable(distro: string, environmentId: string): Promise<boolean>
  /** The same check, telling a confirmed-stopped distro from an unconfirmed one. */
  reachability(distro: string, environmentId: string): Promise<WslHostReachability>
  /** Liveness is deciding whether the distro stopped; its running list may be stale. */
  isSettling(distro: string): boolean
  disconnect(distro: string): Promise<void>
  /** Ends the host's terminals, orcad and its terminal daemon; never boots a stopped distro. */
  stopServer(distro: string, environmentId: string): Promise<WslHostServerStop>
  releaseHolder(distro: string): Promise<void>
  adoptHolders(): Promise<void>
  dispose(): Promise<void>
}
