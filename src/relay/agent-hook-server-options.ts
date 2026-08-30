import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookServerOptions = {
  endpointDir?: string
  env?: string
  token?: string
  preferredPort?: number
  forward: RelayHookForward
  /**
   * True when the host has been told this pane's tab is gone and no PTY has re-bound the paneKey.
   * Posts from such a pane come from a process the user already closed, so they describe no surface
   * any client owns. Defaults to "never retired", which is the pre-existing behaviour — a listener
   * with no PTY handler behind it (the WSL relay) keeps forwarding everything.
   */
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}
