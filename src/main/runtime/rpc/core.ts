import { ZodError, type ZodType } from 'zod'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type { StructuredAgentCliSourceEvidence } from '../../native-chat/structured-agent-cli-source'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../../shared/mobile-relay-credential-contract'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type {
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult
} from '../../../shared/mobile-relay-hosts-contract'
import type {
  DelegatedPhone,
  DelegatedMobileDeviceSyncResult
} from '../../../shared/delegated-mobile-device-contract'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import type { RpcCallerIdentity } from './rpc-caller-identity'
import type { RpcBinarySender } from './rpc-binary-sender'
import type { RpcMethodPermission } from './rpc-method-permission'
import type {
  RegisterDeviceKeyParams,
  RegisterDeviceKeyResult
} from '../../../shared/device-key-registration-contract'

// Bind key rotation to the authenticated socket so callers can re-key only themselves.
export type DeviceSelfRpcContext = {
  registerDeviceKey(params: RegisterDeviceKeyParams): RegisterDeviceKeyResult
}

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
  orchestrationContractVersion?: number
  orchestrationRequestId?: string
  compatibilityInvocationId?: string
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  // Untrusted wire evidence; runtime-source-admission validates it.
  expectedRuntimeSource?: unknown
  // Phone-supplied runtime target; validate at its point of use.
  executionHost?: unknown
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
  // Release long-poll handlers immediately when the client disconnects.
  signal?: AbortSignal
  // Cleanup is socket-scoped so sibling sockets sharing a device token survive.
  connectionId?: string
  // An unsubscribe cannot retire a registration created after its dispatch began.
  subscriptionRegistrationVersion?: number
  structuredAgentCliSourceEvidence?: StructuredAgentCliSourceEvidence
  // Multiplexed streams need request-scoped cleanup within their shared socket.
  requestId?: string
  // Device-scoped handlers release owned state when that client disconnects.
  clientId?: string
  // Key navigation by revocable device identity, never bearer token or socket id.
  pairedDeviceId?: string
  // Delegated phones use their parent desktop's workspaces.
  pairedDeviceParentId?: string
  // Host-assigned transport identity; absent means the caller could not be established.
  caller?: RpcCallerIdentity
  // Only phones receive truncated payloads; undefined in-process callers remain unclipped.
  clientKind?: 'mobile' | 'runtime'
  // Trust socket-negotiated capabilities, never destructive request assertions.
  clientCapabilities?: readonly RuntimeCapability[]
  // Capability upgrades mutate only the authenticated socket after exact-key v2 auth.
  updateClientCapabilities?: (capabilities: readonly RuntimeCapability[]) => void
  // Durable mutation acceptance may precede a long-lived waiter's settlement.
  recordMutationReceipt?: (receipt: unknown) => void
  // Only local worker_done can prove its atomic settlement transaction never committed.
  markWorkerDoneMutationEffectFree?: () => void
  // Prompt retries stop once PTY write effects become ambiguous.
  markMutationEffectPossible?: () => void
  // Commit operation identity with worker-start so crash recovery can inspect it.
  orchestrationMutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
  // A replay with --wait-submit observes its receipt rather than writing again.
  replayedMutationReceipt?: unknown
  // Compare declared Run handles against request attestation.
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  // Resolve the injected Orca session id once at dispatch; session identity wins.
  orchestrationCaller?: OrchestrationSessionCaller
  // Only the trusted compatibility router sets this; params cannot bypass Run consumer binding.
  legacyCoordinatorRunId?: string
  legacyCoordinatorAuthority?: LegacyCoordinatorAuthorityProof
  revalidateLegacyCoordinator?: () => string
  orchestrationCompatibilityCallerAuthority?: OrchestrationCompatibilityCallerAuthority
  // Pin authenticated federation identity without exposing its token to handlers or storage.
  authenticatedCallerFingerprint?: string
  pairing?: PairingRpcContext
  deviceSelf?: DeviceSelfRpcContext
  // Available only on a desktop relay for its configured servers.
  mobileRelayHosts?: {
    list(): MobileRelayHostsListResult
    worktrees(hostId: string): Promise<MobileRelayHostWorktreesResult>
  }
  // Authenticated runtime devices may manage only their own delegated phones.
  delegatedMobileDevices?: {
    sync(phones: readonly DelegatedPhone[]): DelegatedMobileDeviceSyncResult
  }
  // Binary terminal transport is absent on Unix and non-E2EE WebSocket paths.
  sendBinary?: RpcBinarySender
  // Register only handler-owned stream ids; binary frames arrive outside JSON-RPC.
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  // Why: non-terminal binary protocols own their dedicated authenticated subscription socket.
  registerBinaryMessageHandler?: (
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ) => () => void
}

// No schema means no params; the handler must not read its first argument.
type RpcParsedParams<TSchema extends ZodType | null> = TSchema extends ZodType
  ? TSchema['_output']
  : void

// Preserve literal name, schema and result types until the registry boundary.
export type RpcTypedMethod<TName extends string, TSchema extends ZodType | null, TResult> = {
  readonly name: TName
  // Every new method must explicitly choose caller permissions.
  readonly permission: RpcMethodPermission
  readonly params: TSchema
  readonly handler: (params: RpcParsedParams<TSchema>, ctx: RpcContext) => TResult
}

export function defineMethod<TName extends string, TSchema extends ZodType | null, TResult>(
  spec: RpcTypedMethod<TName, TSchema, TResult>
): RpcTypedMethod<TName, TSchema, TResult> {
  return spec
}

// Emit callbacks have no result position for inference; emitted values remain unknown.
export type RpcTypedStreamingMethod<TName extends string, TSchema extends ZodType | null> = {
  readonly name: TName
  readonly permission: RpcMethodPermission
  readonly params: TSchema
  readonly stream: true
  readonly handler: (
    params: RpcParsedParams<TSchema>,
    ctx: RpcContext,
    emit: (result: unknown) => void
  ) => Promise<void>
}

export function defineStreamingMethod<TName extends string, TSchema extends ZodType | null>(
  spec: Omit<RpcTypedStreamingMethod<TName, TSchema>, 'stream'>
): RpcTypedStreamingMethod<TName, TSchema> {
  return { ...spec, stream: true }
}

type RpcMethodWithParams<P> = {
  readonly name: string
  readonly permission: RpcMethodPermission
  readonly params: ZodType | null
  readonly handler: (params: P, ctx: RpcContext) => unknown
}

type RpcStreamingMethodWithParams<P> = {
  readonly name: string
  readonly permission: RpcMethodPermission
  readonly params: ZodType | null
  readonly stream: true
  readonly handler: (params: P, ctx: RpcContext, emit: (result: unknown) => void) => Promise<void>
}

// never makes declarations supertypes of parsed handlers until registry erasure.
export type RpcMethodDeclaration = RpcMethodWithParams<never>
type RpcStreamingMethodDeclaration = RpcStreamingMethodWithParams<never>
export type RpcAnyMethodDeclaration = RpcMethodDeclaration | RpcStreamingMethodDeclaration

// The erased registry accepts unknown; the dispatcher always parses before invoking handlers.
export type RpcMethod = RpcMethodWithParams<unknown>
export type RpcStreamingMethod = RpcStreamingMethodWithParams<unknown>
type RpcAnyMethod = RpcMethod | RpcStreamingMethod

// Erasure drops params types while preserving one-shot versus streaming dispatch.
export function eraseRpcMethods(methods: readonly RpcMethodDeclaration[]): readonly RpcMethod[]
export function eraseRpcMethods(
  methods: readonly RpcStreamingMethodDeclaration[]
): readonly RpcStreamingMethod[]
export function eraseRpcMethods(
  methods: readonly RpcAnyMethodDeclaration[]
): readonly RpcAnyMethod[]
// Erase once after contravariance blocks assignment; handlers still receive dispatcher-parsed input.
export function eraseRpcMethods(
  methods: readonly RpcAnyMethodDeclaration[]
): readonly RpcAnyMethod[] {
  return methods as readonly RpcAnyMethod[]
}

// Unsubscribes that must not retire a registration created after their dispatch began.
export function isRegistrationFencedUnsubscribe(method: string): boolean {
  return method === 'terminal.unsubscribe' || method === 'session.tabs.unsubscribe'
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

// CLI displays the first schema-authored user-facing validation message.
export function formatZodError(error: ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'invalid_argument'
}

export { ZodError }
