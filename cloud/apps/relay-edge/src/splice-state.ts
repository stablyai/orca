// SpliceRelay's stored per-connection state and per-socket attachment shapes.
export type State = {
  connId: string
  relayHostId: string
  phase: 'auth' | 'pending' | 'spliced'
  deadline: number
  connTicket?: string
  generation?: number
}
export type SocketKind = 'phone' | 'data'
// Per-direction flood guard: bytes forwarded to a peer since that peer last sent anything.
// place: client ingress '<continent>/<colo>', for metrics.
// sentBytes/sentFrames: what this socket sent, kept on the attachment so it survives hibernation.
export type GuardAttachment = { silentBytes: number; windowStart: number; place?: string; sentBytes?: number; sentFrames?: number }

export const NO_DEADLINE = Number.MAX_SAFE_INTEGER
export const KEY_PREFIX = 'splice:'
