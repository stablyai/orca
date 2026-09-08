// Wire-protocol types and RPC-frame guards shared by WebSessionClient and its
// WebSessionConnection transport — split out of web-session-client.ts to keep
// that file under oxlint's max-lines budget.
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export type WebRuntimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'auth-failed'

export type PendingRequest = {
  method: string
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: Error) => void
  timeout: number
}

export type SubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

export type RuntimeSubscription = {
  method: string
  params: unknown
  callbacks: SubscriptionCallbacks
}

export type WebRuntimeSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type SubscribeOptions = {
  timeoutMs?: number
  buildUnsubscribe?: (params: unknown) => { method: string; params: unknown } | null
}

export const REQUEST_TIMEOUT_MS = 30_000

// Why: `response.id` is only ever registered in ONE of `subscriptions`/`pending`
// (ids come from the same per-connection nextId() counter, never reused), so a
// truthy `this.subscriptions.get(response.id)` lookup already proves this
// response belongs to that subscription — any well-formed response for it
// should route to onResponse. The old streaming/end/scrollback-only gate
// silently dropped a StreamChannelHandler's plain, non-streaming ack
// (registry.go's DispatchStreamChannel writes it via writeDialectResult with
// no `streaming` flag; only later push events get `streaming: true` — see
// push_bridge.go's pipePushForDialect) — found auditing FE-TASK-EVM-002's
// subscribeRuntimeStreamChannel, which depends on that first ack arriving.
export function isSubscriptionResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> {
  return 'ok' in response
}

export function isRuntimeFailureResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> & { ok: false } {
  return (
    'ok' in response &&
    response.ok === false &&
    'error' in response &&
    !!response.error &&
    typeof response.error === 'object' &&
    'code' in response.error
  )
}

export function isEndResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    'type' in result &&
    (result as { type: string }).type === 'end'
  )
}
