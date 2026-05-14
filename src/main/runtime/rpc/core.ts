// Why: this is the single boundary between raw RPC frames and the OrcaRuntimeService.
// Keeping the schema, handler, and result type attached to one object makes the
// CLI-facing contract greppable and lets the dispatcher verify every payload
// against the same shape the handler consumed during development.
import { ZodError, type ZodType } from 'zod'
import type { OrcaRuntimeService } from '../orca-runtime'

export type RpcEnvelopeMeta = {
  runtimeId: string
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta: RpcEnvelopeMeta
}

export type RpcFailure = {
  id: string
  ok: false
  error: {
    code: string
    message: string
    data?: unknown
  }
  _meta: RpcEnvelopeMeta
}

export type RpcResponse = RpcSuccess | RpcFailure

export type RpcRequest = {
  id: string
  authToken: string
  method: string
  params?: unknown
}

export type RpcContext = {
  runtime: OrcaRuntimeService
  // Why: long-poll handlers (e.g. orchestration.check with wait=true) need to
  // observe the underlying socket's lifetime so they can release their slot
  // and resolve their inner waiters immediately when a client disconnects
  // instead of running down the configured timeoutMs. Undefined outside the
  // runtime-rpc transport (direct in-process callers don't need it).
  // See design doc §3.1 counter-lifecycle.
  signal?: AbortSignal
  // Why: streaming handlers (notifications/accounts/terminal subscribe)
  // register cleanup callbacks against the runtime so reconnects don't leak
  // listeners. Keying those cleanups by per-WebSocket connectionId lets the
  // server reap all subscriptions for a closing socket, even when other
  // sockets for the same deviceToken stay alive (multi-screen mobile).
  connectionId?: string
  // Why: WebSocket RPCs authenticate by mobile device token. State-owning
  // handlers use this to clean up when that paired device disconnects.
  clientId?: string
  // Why: mobile terminal traffic is byte-oriented and bypasses JSON streaming
  // responses after the binary terminal cutover. Undefined on Unix/socket
  // transports and non-E2EE WebSocket paths.
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type RpcHandler<TParams> = (params: TParams, ctx: RpcContext) => Promise<unknown> | unknown

// Why: defineMethod preserves the inferred param type locally so each handler
// is fully typed, but the erased `RpcMethod` form is what the dispatcher
// actually stores. The erasure lives in one cast inside defineMethod rather
// than in every method file, which is the tradeoff for the variance problem
// of `RpcHandler` being contravariant in its param type.
export type RpcMethod = {
  readonly name: string
  readonly params: ZodType | null
  readonly handler: (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown
}

type DefineMethodSpec<TSchema extends ZodType | null> = {
  name: string
  params: TSchema
  handler: RpcHandler<TSchema extends ZodType ? TSchema['_output'] : void>
}

export function defineMethod<TSchema extends ZodType | null>(
  spec: DefineMethodSpec<TSchema>
): RpcMethod {
  return {
    name: spec.name,
    params: spec.params,
    handler: spec.handler as RpcMethod['handler']
  }
}

export type RpcStreamingHandler<TParams> = (
  params: TParams,
  ctx: RpcContext,
  emit: (result: unknown) => void
) => Promise<void>

// Why: streaming methods emit multiple responses over a long-lived connection.
// The `stream` flag lets the dispatcher distinguish them from one-shot methods
// and route them to the emit-based call path instead of the Promise-based one.
export type RpcStreamingMethod = {
  readonly name: string
  readonly params: ZodType | null
  readonly stream: true
  readonly handler: (
    params: unknown,
    ctx: RpcContext,
    emit: (result: unknown) => void
  ) => Promise<void>
}

type DefineStreamingMethodSpec<TSchema extends ZodType | null> = {
  name: string
  params: TSchema
  handler: RpcStreamingHandler<TSchema extends ZodType ? TSchema['_output'] : void>
}

export function defineStreamingMethod<TSchema extends ZodType | null>(
  spec: DefineStreamingMethodSpec<TSchema>
): RpcStreamingMethod {
  return {
    name: spec.name,
    params: spec.params,
    stream: true,
    handler: spec.handler as RpcStreamingMethod['handler']
  }
}

export type RpcAnyMethod = RpcMethod | RpcStreamingMethod

export function isStreamingMethod(method: RpcAnyMethod): method is RpcStreamingMethod {
  return 'stream' in method && method.stream === true
}

export type RpcRegistry = ReadonlyMap<string, RpcAnyMethod>

export function buildRegistry(methods: readonly RpcAnyMethod[]): RpcRegistry {
  const registry = new Map<string, RpcAnyMethod>()
  for (const method of methods) {
    if (registry.has(method.name)) {
      throw new Error(`duplicate_rpc_method:${method.name}`)
    }
    registry.set(method.name, method)
  }
  return registry
}

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgumentError'
  }
}

// Why: zod aggregates all failing fields into `issues`, but the CLI surfaces
// a single string to users. Pick the first issue's message so callers see a
// message that matches the original handler's `Missing terminal handle`-style
// phrasing (each schema supplies that literal message on its own constraint).
export function formatZodError(error: ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'invalid_argument'
}

export { ZodError }
