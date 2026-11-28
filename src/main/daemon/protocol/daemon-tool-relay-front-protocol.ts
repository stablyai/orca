// A daemon start's tool relay front (`toolRelayFront` in its hello identity). Older daemons lack it,
// so an app asks only one that advertises it; older apps never ask.

/** Opens (once) this start's front; the reply names its port and the start that holds it. */
export type ToolRelayFrontOpenRequest = { id: string; type: 'toolRelayFrontOpen' }
export type ToolRelayFrontOpenResult = { port: number; daemonInstance: string }

/** A kept agent's relay grant: the token its tools carry, and the folders it reaches. */
export type ToolRelayFrontGrant = {
  owner: string
  token: string
  folders: { bot?: string; host?: string }
}

/** A kept agent's shared-tool caller: the token its tools send, and the chat identity it names. */
export type ToolRelayFrontCaller = { owner: string; token: string; caller: Record<string, string> }

/**
 * What a kept agent's tools need from the app, sent with its `relaySpawn` (only to a daemon with a
 * front). The daemon holds it in memory only, for as long as that agent's relay runs.
 */
export type ToolRelayFrontKept = { grants: ToolRelayFrontGrant[]; caller?: ToolRelayFrontCaller }

export type ToolRelayFrontKeptRelay = ToolRelayFrontKept & { relayId: string; chatKey: string }

/**
 * This client answers the front's connections from now on; `port` is null before any open. The
 * reply carries every running kept agent's grants, so a restarted app recognizes their tokens.
 */
export type ToolRelayFrontServeRequest = { id: string; type: 'toolRelayFrontServe' }
export type ToolRelayFrontServeResult = {
  port: number | null
  daemonInstance: string
  kept: ToolRelayFrontKeptRelay[]
}

/** The owner's grants and callers leave every relay of this start (its bot was deleted). */
export type ToolRelayFrontRevokeRequest = {
  id: string
  type: 'toolRelayFrontRevoke'
  payload: { owner: string }
}

export type ToolRelayFrontRequest =
  | ToolRelayFrontOpenRequest
  | ToolRelayFrontServeRequest
  | ToolRelayFrontRevokeRequest

export const TOOL_RELAY_FRONT_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'toolRelayFrontOpen',
  'toolRelayFrontServe',
  'toolRelayFrontRevoke'
])

/**
 * Sent on the serving client's stream: open a `tool-relay` connection naming `frontConnectionId`;
 * `keptEnded`: that relay ended, so its agent's grants are gone here; `keptChanged`: relays ended
 * while the stream was backed up, so serve again to learn which grants are left.
 */
export type ToolRelayFrontEventPayload =
  | { frontConnectionId: string }
  | { keptEnded: string }
  | { keptChanged: true }

export type ToolRelayFrontConnectionEvent = {
  type: 'event'
  event: 'toolRelayFrontConnection'
  sessionId: 'tool-relay-front'
  payload: ToolRelayFrontEventPayload
}

export const TOOL_RELAY_FRONT_EVENT = 'toolRelayFrontConnection'
export const TOOL_RELAY_HELLO_ROLE = 'tool-relay' as const
