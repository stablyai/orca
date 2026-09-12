// Unit 6: connection-scoped types shared between MockOrcaServer and its terminal RPC handlers
// (kept in their own file to avoid a circular import between the two).

export type TerminalSubscriptionState = {
  streamId: number
  seq: number
  /** binary iff the subscribe call carried `capabilities.terminalBinaryStream: 1` (verified
   *  against terminal-subscribe-method.ts) — otherwise the host publishes JSON events only. */
  mode: 'binary' | 'json'
  /** JSON-mode pushes are follow-up `streaming:true` responses under the SUBSCRIBE request's id
   *  (dispatcher-streaming-feature-emitter.ts), not a fresh id per push. */
  requestId: string
}

export type ConnectionState = {
  sharedKey: Uint8Array
  authenticated: boolean
  notificationSubscriptionId: string | null
  terminalSubscriptions: Map<string, TerminalSubscriptionState>
}

export type RpcRequestLike = {
  id: string
  deviceToken?: string
  method: string
  params?: Record<string, unknown>
}

export function normalizeWorktreeSelector(selector: unknown): string | undefined {
  return typeof selector === 'string' ? selector.replace(/^id:/, '') : undefined
}
