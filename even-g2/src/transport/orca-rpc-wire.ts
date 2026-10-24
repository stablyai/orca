// Contract module (Unit 0). Local copies of the pure wire types — shapes identical to
// mobile/src/transport/types.ts, which is not importable here (it pulls mobile-relay modules
// even-g2 doesn't need). Keep in sync with that file's RpcRequest/RpcResponse/ConnectionState.

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'auth-failed'
  | 'disconnected'

// Narrow client port state slices (Unit 4) depend on, so they never import the concrete
// OrcaSocketClient (Unit 3); MockOrcaServer tests can drive slices through a stub RpcPort.
export type RpcPort = {
  sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<RpcResponse>
  subscribe(
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    onBinary?: (payload: Uint8Array) => void
  ): () => void
}
