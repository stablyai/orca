import type {
  AgentHookRelayEnvelope,
  AgentHookUnavailableEnvelope
} from '../shared/agent-hook-relay'
import type { TmuxManagedPty } from '../shared/tmux-agent-hook-owner'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", which main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Fixed auth token. WSL relay passes the host-issued token (already in guest env via WSLENV) so unmodified hook clients authenticate. Defaults to a fresh UUID. */
  token?: string
  /** Preferred bind port. WSL relay passes the Windows listener's port so env-sourced client coords stay truthful; falls back to :0 if occupied. Defaults to :0. */
  preferredPort?: number
  forwardUnavailable?: (envelope: AgentHookUnavailableEnvelope) => void
  forward: RelayHookForward
  /**
   * True when the host has been told this pane's tab is gone and no PTY has re-bound the paneKey.
   * Posts from such a pane come from a process the user already closed, so they describe no surface
   * any client owns. Defaults to "never retired", which is the pre-existing behaviour — a listener
   * with no PTY handler behind it (the WSL relay) keeps forwarding everything.
   */
  getTmuxManagedPty?: (paneKey: string) => Promise<TmuxManagedPty | null>
  /** Token captured from the successful host spawn; absent authority keeps the physical poster. */
  getAgentLaunchToken?: (paneKey: string) => string | undefined
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}
