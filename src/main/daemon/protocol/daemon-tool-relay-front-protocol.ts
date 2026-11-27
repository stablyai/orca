// A daemon start's tool relay front (`toolRelayFront` in its hello identity). Older daemons lack it,
// so an app asks only one that advertises it; older apps never ask.

/** Opens (once) this start's front; the reply names its port and the start that holds it. */
export type ToolRelayFrontOpenRequest = { id: string; type: 'toolRelayFrontOpen' }
export type ToolRelayFrontOpenResult = { port: number; daemonInstance: string }

/** This client answers the front's connections from now on; `port` is null before any open. */
export type ToolRelayFrontServeRequest = { id: string; type: 'toolRelayFrontServe' }
export type ToolRelayFrontServeResult = { port: number | null; daemonInstance: string }

export type ToolRelayFrontRequest = ToolRelayFrontOpenRequest | ToolRelayFrontServeRequest

export const TOOL_RELAY_FRONT_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'toolRelayFrontOpen',
  'toolRelayFrontServe'
])

/** Sent on the serving client's stream: open a `tool-relay` connection naming this id. */
export type ToolRelayFrontConnectionEvent = {
  type: 'event'
  event: 'toolRelayFrontConnection'
  sessionId: 'tool-relay-front'
  payload: { frontConnectionId: string }
}

export const TOOL_RELAY_FRONT_EVENT = 'toolRelayFrontConnection'
export const TOOL_RELAY_HELLO_ROLE = 'tool-relay' as const
