// Why: single boundary between raw RPC frames and OrcaRuntimeService; keeps schema, handler, and result type on one object.
import { ZodError, type ZodType } from 'zod'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'

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
  orchestrationCapability?: string
  orchestrationContractVersion?: number
  orchestrationRequestId?: string
  compatibilityInvocationId?: string
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
}

export type LegacyCoordinatorAuthorityProof = Readonly<{
  runId: string
  principalId: string | null
  terminalHandle: string
  paneKey: string
  consumerGeneration: number
}>

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
  // Why: navigation is keyed by revocable device identity, never by the bearer credential or transient socket id.
  pairedDeviceId?: string
  // Why: lets handlers gate mobile payload truncation to phones only; undefined for in-process callers → treat as full-class (no clip).
  clientKind?: 'mobile' | 'runtime'
  // Why: negotiation is bound to the authenticated socket, never asserted by a destructive request.
  clientCapabilities?: readonly RuntimeCapability[]
  // Why: mobile v2 auth is exact-key validated; capability upgrades must mutate only the authenticated socket after auth.
  updateClientCapabilities?: (capabilities: readonly RuntimeCapability[]) => void
  // Why: Dispatch authority rides in the authenticated RPC envelope, never in user payload fields.
  orchestrationCapability?: string
  // Why: long-lived mutations such as ask can durably expose acceptance before their waiter settles.
  recordMutationReceipt?: (receipt: unknown) => void
  // Why: only local worker_done makes pending proof that its atomic settlement transaction never committed.
  markWorkerDoneMutationEffectFree?: () => void
  // Why: prompt receipts may retry only until the PTY write boundary makes effects ambiguous.
  markMutationEffectPossible?: () => void
  // Why: worker-start commits this identity with its starting Dispatch so crash recovery always has an inspectable operation.
  orchestrationMutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
  // Why: a prompt retry with --wait-submit observes its durable receipt instead of writing again.
  replayedMutationReceipt?: unknown
  // Why: Run-scoped handlers must compare declared handles with request attestation.
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  // Why: only the compatibility authority router can set this trusted scope; user params cannot bypass Run consumer binding.
  legacyCoordinatorRunId?: string
  legacyCoordinatorAuthority?: LegacyCoordinatorAuthorityProof
  revalidateLegacyCoordinator?: () => string
  orchestrationCompatibilityCallerAuthority?: OrchestrationCompatibilityCallerAuthority
  // Why: federation pins the authenticated saved-environment caller without exposing its token to handlers or storage.
  authenticatedCallerFingerprint?: string
  pairing?: PairingRpcContext
  // Why: mobile terminal traffic bypasses JSON streaming; undefined on Unix/socket and non-E2EE WebSocket paths.
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  // Why: binary terminal frames arrive outside JSON-RPC once a stream is established; handlers register only the stream IDs they created.
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  // Why: non-terminal binary protocols own their dedicated authenticated subscription socket.
  registerBinaryMessageHandler?: (
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ) => () => void
}

export type RpcHandler<TParams, TResult> = (params: TParams, ctx: RpcContext) => TResult

// Why: a schema-less method takes no params, so its handler must not be able to read the first argument.
type RpcParsedParams<TSchema extends ZodType | null> = TSchema extends ZodType
  ? TSchema['_output']
  : void

// Why: the authored shape — literal name, params schema, and producer result all survive for compile-time contracts.
export type RpcTypedMethod<TName extends string, TSchema extends ZodType | null, TResult> = {
  readonly name: TName
  readonly params: TSchema
  readonly handler: RpcHandler<RpcParsedParams<TSchema>, TResult>
}

export function defineMethod<TName extends string, TSchema extends ZodType | null, TResult>(
  spec: RpcTypedMethod<TName, TSchema, TResult>
): RpcTypedMethod<TName, TSchema, TResult> {
  return {
    name: spec.name,
    params: spec.params,
    handler: spec.handler
  }
}

export type RpcStreamingHandler<TParams> = (
  params: TParams,
  ctx: RpcContext,
  emit: (result: unknown) => void
) => Promise<void>

// Why: emitted values stay `unknown` — the emit callback is an input, so there is no return position to infer them from.
export type RpcTypedStreamingMethod<TName extends string, TSchema extends ZodType | null> = {
  readonly name: TName
  readonly params: TSchema
  readonly stream: true
  readonly handler: RpcStreamingHandler<RpcParsedParams<TSchema>>
}

export function defineStreamingMethod<TName extends string, TSchema extends ZodType | null>(
  spec: Omit<RpcTypedStreamingMethod<TName, TSchema>, 'stream'>
): RpcTypedStreamingMethod<TName, TSchema> {
  return {
    name: spec.name,
    params: spec.params,
    stream: true,
    handler: spec.handler
  }
}

// Why `never` params: it makes the declaration a supertype of every parsed-params handler, so typed methods
// travel to the registry boundary — and only there get erased — without a cast in each methods module.
export type RpcMethodDeclaration = {
  readonly name: string
  readonly params: ZodType | null
  readonly handler: (params: never, ctx: RpcContext) => unknown
}

export type RpcStreamingMethodDeclaration = {
  readonly name: string
  readonly params: ZodType | null
  readonly stream: true
  readonly handler: (
    params: never,
    ctx: RpcContext,
    emit: (result: unknown) => void
  ) => Promise<void>
}

export type RpcAnyMethodDeclaration = RpcMethodDeclaration | RpcStreamingMethodDeclaration

// Why: RpcMethod is the registry's erased view; the dispatcher parses params itself and hands handlers `unknown`.
export type RpcMethod = {
  readonly name: string
  readonly params: ZodType | null
  readonly handler: (params: unknown, ctx: RpcContext) => unknown
}

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

export type RpcAnyMethod = RpcMethod | RpcStreamingMethod

// Why the overloads: erasure drops the parsed-params type, not the one-shot/streaming split the dispatcher routes on.
export function eraseRpcMethods(methods: readonly RpcMethodDeclaration[]): readonly RpcMethod[]
export function eraseRpcMethods(
  methods: readonly RpcStreamingMethodDeclaration[]
): readonly RpcStreamingMethod[]
export function eraseRpcMethods(
  methods: readonly RpcAnyMethodDeclaration[]
): readonly RpcAnyMethod[]
// Why: the one place the parsed-params type is dropped — contravariance makes it uncastable by assignment, and
// the dispatcher only ever calls a handler with an already-parsed `unknown`. Runtime value is untouched.
export function eraseRpcMethods(
  methods: readonly RpcAnyMethodDeclaration[]
): readonly RpcAnyMethod[] {
  return methods as readonly RpcAnyMethod[]
}

export function isStreamingMethod(method: RpcAnyMethod): method is RpcStreamingMethod {
  return 'stream' in method && method.stream === true
}

export type RpcRegistry = ReadonlyMap<string, RpcAnyMethod>

export function buildRegistry(methods: readonly RpcAnyMethodDeclaration[]): RpcRegistry {
  const registry = new Map<string, RpcAnyMethod>()
  for (const method of eraseRpcMethods(methods)) {
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
