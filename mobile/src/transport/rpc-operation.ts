import {
  isMethodNotFoundRefusal,
  isStreamingOpenerReply,
  requireRpcResultOrThrowCodedError,
  requireRpcResultOrThrowMessage,
  rpcSuccessResultOrSkip
} from './rpc-acceptance-policies'
import { RpcIncompatibleReplyError } from './rpc-incompatible-reply-error'
import type { UnvalidatedRpcRequestPort, SendRequestOptions } from './unvalidated-rpc-request-port'
import type { RpcMethodName, RpcSendParams } from './rpc-params-contract'
import { classifyRpcReply } from './rpc-operation-reply'
import { sendSingleFlightRequest } from './request-single-flight'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'
import type {
  AnyRpcOperation,
  CapabilityProbeRpcDefinition,
  ObjectResultRpcDefinition,
  RpcAcceptanceName,
  RpcCompatibleReader,
  RpcInterpretationBarrier,
  RpcOperation,
  RpcOperationSettlement,
  RpcRequestOutcome,
  RequireResultRpcDefinition,
  StreamOpenerRpcDefinition,
  RpcVerdict,
  LegacyResultRpcDefinition
} from './rpc-operation-contract'

type RpcOperationDefinitionInput =
  | LegacyResultRpcDefinition<
      RpcMethodName,
      'success-result-or-skip' | 'require-result-or-throw-message',
      string,
      unknown,
      RpcInterpretationBarrier
    >
  | RequireResultRpcDefinition<RpcMethodName, string, unknown, RpcInterpretationBarrier>
  | ObjectResultRpcDefinition<RpcMethodName, string, unknown, RpcInterpretationBarrier>
  | CapabilityProbeRpcDefinition<RpcMethodName, RpcInterpretationBarrier>
  | StreamOpenerRpcDefinition<RpcMethodName, RpcInterpretationBarrier>

export function defineRpcOperation<
  Method extends RpcMethodName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
>(
  definition: RequireResultRpcDefinition<Method, Variant, Value, Barrier>
): RpcOperation<Method, 'require-result-or-throw', Variant, Value, Barrier>
export function defineRpcOperation<
  Method extends RpcMethodName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
>(
  definition: ObjectResultRpcDefinition<Method, Variant, Value, Barrier>
): RpcOperation<Method, 'object-result-or-null', Variant, Value, Barrier>
export function defineRpcOperation<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
>(
  definition: CapabilityProbeRpcDefinition<Method, Barrier>
): RpcOperation<Method, 'method-not-found-refusal', 'accepted', unknown, Barrier>
export function defineRpcOperation<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
>(
  definition: StreamOpenerRpcDefinition<Method, Barrier>
): RpcOperation<Method, 'streaming-opener', 'stream-opened', unknown, Barrier>
export function defineRpcOperation<
  Method extends RpcMethodName,
  Acceptance extends 'success-result-or-skip' | 'require-result-or-throw-message',
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
>(
  definition: LegacyResultRpcDefinition<Method, Acceptance, Variant, Value, Barrier>
): RpcOperation<Method, Acceptance, Variant, Value, Barrier>
export function defineRpcOperation(definition: RpcOperationDefinitionInput): AnyRpcOperation {
  // Why: frozen so no call site can swap the policy or the barrier on a shared descriptor.
  return Object.freeze({
    name: definition.name,
    method: definition.method,
    acceptance: definition.acceptance,
    barrier: definition.barrier,
    // Why: classifyRpcReply only ever hands a reader the payload its own policy admitted, so
    // the object policy's narrower parameter is sound to store as unknown.
    read: definition.read as RpcCompatibleReader<unknown, string, unknown> | undefined
  })
}

/** Sends the operation without interpreting it; transport rejection stays on the promise. */
async function request(
  client: UnvalidatedRpcRequestPort,
  operation: AnyRpcOperation,
  params: unknown,
  options?: SendRequestOptions
): Promise<RpcRequestOutcome<string, unknown>> {
  // Why: no try/catch here. A transport failure must reach the caller as the original error
  // object — isLogicalClientCutoverError and isRpcDeliveryUnknown both die on a wrapper —
  // and an always-settled send would make Promise.all wait for a peer where today the group
  // fails immediately, letting a later policy surface a different error.
  const response = await client.sendRequest(operation.method, params, options)
  return classifyRpcReply(operation, response)
}

// Applies the operation's declared acceptance policy. Private on purpose: there is no
// free-standing callOrThrow, so no call site can pick a different rule for the same reply.
function interpretRpcOutcome(
  operation: AnyRpcOperation,
  settled: RpcRequestOutcome<string, unknown>
): unknown {
  const acceptance: RpcAcceptanceName = operation.acceptance
  switch (acceptance) {
    case 'success-result-or-skip': {
      const accepted = rpcSuccessResultOrSkip(settled.raw)
      if (!accepted.accepted) {
        return accepted
      }
      if (settled.kind === 'incompatible') {
        throw new RpcIncompatibleReplyError(operation.name, operation.method, settled.issues)
      }
      return settled.kind === 'decoded'
        ? { accepted: true, value: settled.value }
        : { accepted: false }
    }
    case 'require-result-or-throw-message':
      if (settled.kind === 'outer-refused') {
        return requireRpcResultOrThrowMessage(settled.raw)
      }
      if (settled.kind === 'incompatible') {
        throw new RpcIncompatibleReplyError(operation.name, operation.method, settled.issues)
      }
      return settled.value
    case 'require-result-or-throw':
      if (settled.kind === 'outer-refused') {
        // Reuses the policy so the thrown `code: message` text cannot drift from main's.
        return requireRpcResultOrThrowCodedError(settled.raw)
      }
      if (settled.kind === 'incompatible') {
        throw new RpcIncompatibleReplyError(operation.name, operation.method, settled.issues)
      }
      return settled.value
    case 'object-result-or-null':
      return settled.kind === 'decoded' ? settled.value : null
    case 'method-not-found-refusal':
      return settled.kind === 'outer-refused' ? isMethodNotFoundRefusal(settled.raw) : false
    case 'streaming-opener':
      return settled.kind === 'decoded' && isStreamingOpenerReply(settled.raw) ? settled.raw : null
  }
}

function interpretSettlement(
  operation: AnyRpcOperation,
  settlement: RpcOperationSettlement<string, unknown>
): unknown {
  if (settlement.status === 'rejected') {
    // Why: rethrow the original object — isRpcDeliveryUnknown is a WeakSet on identity and
    // isLogicalClientCutoverError matches class or exact message; a wrapper loses both.
    throw settlement.error
  }
  return interpretRpcOutcome(operation, settlement.outcome)
}

/** Sends and interprets at the operation's own barrier. Only for barrier 'on-settle'. */
export async function runRpcOperation<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value
>(
  client: UnvalidatedRpcRequestPort,
  operation: RpcOperation<Method, Acceptance, Variant, Value, 'on-settle'>,
  params: RpcSendParams<Method>,
  options?: SendRequestOptions
): Promise<RpcVerdict<Acceptance, Value>> {
  const outcome = await request(client, operation, params, options)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return interpretRpcOutcome(operation, outcome) as RpcVerdict<Acceptance, Value>
}

/** The named opt-in to all-settled semantics. Yields an outcome, never a verdict: the
 *  verdict still comes only from the declared policy, at the declared barrier. */
export async function captureRpcOperationSettlement<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value,
  Barrier extends Exclude<RpcInterpretationBarrier, 'after-caller-barrier'>
>(
  client: UnvalidatedRpcRequestPort,
  operation: RpcOperation<Method, Acceptance, Variant, Value, Barrier>,
  params: RpcSendParams<Method>,
  options?: SendRequestOptions
): Promise<RpcOperationSettlement<Variant, Value>> {
  try {
    const outcome = await request(client, operation, params, options)
    return { status: 'fulfilled', outcome: outcome as RpcRequestOutcome<Variant, Value> }
  } catch (error) {
    return { status: 'rejected', error }
  }
}

export type PendingRpcOperation<Op extends AnyRpcOperation> = {
  readonly operation: Op
  readonly settlement: Promise<RpcOperationSettlement<string, unknown>>
}

/** Starts a request whose interpretation is deferred to the barrier it declared. */
export function startRpcOperation<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value
>(
  client: UnvalidatedRpcRequestPort,
  operation: RpcOperation<Method, Acceptance, Variant, Value, 'after-all-requests'>,
  params: RpcSendParams<Method>,
  options?: SendRequestOptions
): PendingRpcOperation<RpcOperation<Method, Acceptance, Variant, Value, 'after-all-requests'>> {
  return {
    operation,
    settlement: captureRpcOperationSettlement(client, operation, params, options)
  }
}

type RpcBarrierVerdicts<Pending extends readonly PendingRpcOperation<AnyRpcOperation>[]> = {
  [Index in keyof Pending]: Pending[Index] extends PendingRpcOperation<
    RpcOperation<RpcMethodName, infer Acceptance, string, infer Value, RpcInterpretationBarrier>
  >
    ? RpcVerdict<Acceptance, Value>
    : never
}

/** Awaits every raw request, then interprets in declared order. */
export async function interpretAtRpcBarrier<
  Pending extends readonly PendingRpcOperation<AnyRpcOperation>[]
>(pending: Pending): Promise<RpcBarrierVerdicts<Pending>> {
  // Why: interpreting as each request lands would let whichever peer failed first decide the
  // error the user sees and how long the screen spins. Declared order makes that a property
  // of the definition instead of a race.
  const settlements = await Promise.all(pending.map((entry) => entry.settlement))
  return pending.map((entry, index) =>
    interpretSettlement(entry.operation, settlements[index])
  ) as RpcBarrierVerdicts<Pending>
}

/**
 * Whether a sender may omit the params argument entirely.
 *
 * A params type with no required field may be omitted as well as `void`, because the raw port
 * always allowed it and several hosts' schemas are entirely optional (`preflight.check`). Forcing
 * `{}` there would put a new object on the wire where main sent no params at all. Shared by both
 * send helpers, so single-flight and direct sends cannot disagree about which methods that covers.
 */
type RpcParamsOmittable<Method extends RpcMethodName> =
  void extends RpcSendParams<Method>
    ? true
    : Record<never, never> extends RpcSendParams<Method>
      ? true
      : false

/**
 * Preserves omitted sender arguments as well as explicit undefined and explicit null.
 *
 * `null` is admitted only where the catalog declares no params at all: several shipped senders put
 * an explicit `null` on the wire for those methods, and a JSON frame carrying `params: null` is not
 * the frame that omits the key. Narrowing them to omission would silently rewrite those bytes.
 */
type RpcSendArguments<Method extends RpcMethodName> =
  void extends RpcSendParams<Method>
    ? [params?: RpcSendParams<Method> | null, options?: SendRequestOptions]
    : RpcParamsOmittable<Method> extends true
      ? [params?: RpcSendParams<Method>, options?: SendRequestOptions]
      : [params: RpcSendParams<Method>, options?: SendRequestOptions]

/** Binds sending and interpretation while preserving the transport promise identity. */
export function bindDeferredRpcOperation<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value
>(operation: RpcOperation<Method, Acceptance, Variant, Value, 'after-caller-barrier'>) {
  type Verdict = RpcVerdict<Acceptance, Value>
  return Object.freeze({
    operation,
    request(client: UnvalidatedRpcRequestPort, ...args: RpcSendArguments<Method>) {
      return client.sendRequest(operation.method, ...args)
    },
    requestSingleFlight(
      client: RpcClient,
      hostId: string,
      ...args: RpcParamsOmittable<Method> extends true
        ? [params?: RpcSendParams<Method>]
        : [params: RpcSendParams<Method>]
    ) {
      return sendSingleFlightRequest(client, hostId, operation.method, args[0])
    },
    interpret(response: RpcResponse): Verdict {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      return interpretRpcOutcome(operation, classifyRpcReply(operation, response)) as Verdict
    }
  })
}
