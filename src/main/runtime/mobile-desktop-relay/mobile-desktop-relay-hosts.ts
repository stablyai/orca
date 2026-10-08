import type { PairingOffer } from '../../../shared/pairing'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/** A configured server the desktop can relay to. */
export type MobileDesktopRelayHost = {
  environmentId: string
  // Pairing revision and runtime identity; delegated grants from another fence are never reused.
  fence: string
  // The desktop's own runtime-scope pairing; the relay swaps in a phone's delegated token.
  pairing: PairingOffer
}

/** The desktop's configured servers, as the relay sees them. */
export type MobileDesktopRelayHosts = {
  /** Null when the id names no configured server; a phone-supplied endpoint is never used. */
  resolve: (environmentId: string) => Promise<MobileDesktopRelayHost | null>
  /** A call as the desktop itself, over its own connection to the server. */
  call: (
    host: MobileDesktopRelayHost,
    method: string,
    params: unknown
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Fires when a server is removed, re-paired or disconnected; returns an unsubscribe. */
  onEnvironmentRetired: (listener: (environmentId: string) => void) => () => void
}
