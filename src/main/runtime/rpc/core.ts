// Why: single boundary between raw RPC frames and OrcaRuntimeService; keeps schema, handler, and result type on one object.
import { ZodError, type ZodType } from 'zod'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'

export type PairingRpcContext = {
  getEndpoints(params: PairingGetEndpointsParams): Promise<PairingGetEndpointsResult>
  provisionRelay(params: PairingProvisionRelayParams): Promise<DeviceCredentialInstalled>
}

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
  // Why: lets long-poll handlers release immediately on client disconnect instead of running down timeoutMs. See design doc §3.1.
  signal?: AbortSignal
  // Why: per-WebSocket key so the server reaps a closing socket's subscriptions without touching sibling sockets sharing the deviceToken.
  connectionId?: string
  // Why: shared-control multiplexes many logical streams over one socket; the frame id lets handlers register cleanup per logical stream.
  requestId?: string
  // Why: paired mobile device token; state-owning handlers use it to clean up when that device disconnects.
  clientId?: string
  // Why: lets handlers gate mobile payload truncation to phones only; undefined for in-process callers → treat as full-class (no clip).
  clientKind?: 'mobile' | 'runtime'
  pairing?: PairingRpcContext
  // Why: mobile terminal traffic bypasses JSON streaming; undefined on Unix/socket and non-E2EE WebSocket paths.
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  // Why: binary terminal frames arrive outside JSON-RPC once a stream is established; handlers register only the stream IDs they created.
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
}

export type RpcHandler<TParams> = (params: TParams, ctx: RpcContext) => Promise<unknown> | unknown

// Why: RpcMethod erases the param type; centralizing the cast in defineMethod sidesteps RpcHandler's contravariance.
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

// Why: the `stream` flag lets the dispatcher route these to the emit-based path instead of the one-shot Promise path.
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

// Why: CLI surfaces one string; take the first issue's message, which each schema authors as the user-facing phrasing.
export function formatZodError(error: ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'invalid_argument'
}

export { ZodError }
