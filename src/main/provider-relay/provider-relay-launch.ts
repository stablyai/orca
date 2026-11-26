import type { ProviderRelayKeepSpec } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'

/** How a chat asks the daemon for its agent: a reattach of the kept one, or a new start. */
export type ProviderRelayLaunch = {
  chatKey: string
  markers: ProviderRelayWorkMarkers
  /** Reattach only: lines this lets through while the rest wait for `releaseOutput()`. */
  passWhileHeld?: (line: string) => boolean
  /** The agent's whole environment, when its caller already scrubbed it (not merged over the app's). */
  inheritedEnv?: Record<string, string>
  /** `spawn`: a still-listed kept agent refuses the start (its reattach is the caller's own). */
  only?: 'spawn' | 'reattach'
  /** Session state the daemon keeps for the next attach; only a daemon that can keep it relays. */
  keep?: ProviderRelayKeepSpec
}
