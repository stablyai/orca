import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { RpcMethodName, RpcParams } from './rpc-params-contract'
import type { RpcResponse } from './types'
import {
  isMethodNotFoundRefusal,
  isStreamingOpenerReply,
  requireRpcResultOrThrowCodedError,
  rpcObjectResultOrNull
} from './rpc-acceptance-policies'
import { RpcIncompatibleReplyError } from './rpc-incompatible-reply-error'
import type {
  AnyRpcOperation,
  CapabilityProbeRpcDefinition,
  ObjectResultRpcDefinition,
  RpcAcceptanceName,
  RpcCompatibleReader,
  RpcDecodeIssue,
  RpcInterpretationBarrier,
  RpcOperation,
  RpcOperationSettlement,
  RpcRequestOutcome,
  RpcSalvageReport,
  RequireResultRpcDefinition,
  StreamOpenerRpcDefinition,
  RpcVerdict
} from './rpc-operation-contract'

const NOTHING_SALVAGED: RpcSalvageReport = { droppedPaths: [], droppedCount: 0 }

type RpcOperationDefinitionInput =
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
export function defineRpcOperation(definition: RpcOperationDefinitionInput): AnyRpcOperation {
  // Why: frozen so no call site can swap the policy or the barrier on a shared descriptor.
  return Object.freeze({
    name: definition.name,
    method: definition.method,
    acceptance: definition.acceptance,
    barrier: definition.barrier,
    consumes: Object.freeze([...definition.consumes]),
    schedules: Object.freeze([...definition.schedules]),
    // Why: classifyReply only ever hands a reader the payload its own policy admitted, so
    // the object policy's narrower parameter is sound to store as unknown.
    read: definition.read as RpcCompatibleReader<unknown, string, unknown> | undefined
  })
}

/** Sends the operation without interpreting it; transport rejection stays on the promise. */
async function request(
  client: RpcClient,
  operation: AnyRpcOperation,
  params: unknown,
  options?: SendRequestOptions
): Promise<RpcRequestOutcome<string, unknown>> {
  // Why: no try/catch here. A transport failure must reach the caller as the original error
  // object — isLogicalClientCutoverError and isRpcDeliveryUnknown both die on a wrapper —
  // and an always-settled send would make Promise.all wait for a peer where today the group
  // fails immediately, letting a later policy surface a different error.
  const response = await client.sendRequest(operation.method, params, options)
  return classifyReply(operation, response)
}

type AdmittedPayload =
  | { readonly admitted: true; readonly value: unknown }
  | { readonly admitted: false; readonly issues: readonly RpcDecodeIssue[] }

// The payload the operation's own acceptance policy admits from a fulfilled success.
function admitPayload(operation: AnyRpcOperation, response: RpcResponse): AdmittedPayload {
  switch (operation.acceptance) {
    case 'object-result-or-null': {
      const object = rpcObjectResultOrNull(response)
      return object === null
        ? { admitted: false, issues: [{ path: 'result', message: 'not a non-null object' }] }
        : { admitted: true, value: object }
    }
    case 'streaming-opener':
      return isStreamingOpenerReply(response)
        ? { admitted: true, value: response }
        : { admitted: false, issues: [{ path: 'streaming', message: 'reply opened no stream' }] }
    default:
      // Reuses the policy rather than reading `.result` again; a success never throws here.
      return { admitted: true, value: requireRpcResultOrThrowCodedError(response) }
  }
}

const READERLESS_VARIANTS: Record<string, string> = {
  'method-not-found-refusal': 'accepted',
  'streaming-opener': 'stream-opened'
}

function classifyReply(
  operation: AnyRpcOperation,
  response: RpcResponse
): RpcRequestOutcome<string, unknown> {
  if (!response.ok) {
    return { kind: 'outer-refused', error: response.error, raw: response }
  }
  const payload = admitPayload(operation, response)
  if (!payload.admitted) {
    return { kind: 'incompatible', raw: response, issues: payload.issues }
  }
  const read = operation.read
  if (!read) {
    return {
      kind: 'decoded',
      variant: READERLESS_VARIANTS[operation.acceptance] ?? 'accepted',
      value: payload.value,
      raw: response,
      salvage: NOTHING_SALVAGED
    }
  }
  let result: ReturnType<typeof read>
  try {
    result = read(payload.value)
  } catch (error) {
    // A reader that throws is an incompatible reply, never a transport failure.
    return {
      kind: 'incompatible',
      raw: response,
      issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }]
    }
  }
  if (!result.compatible) {
    return { kind: 'incompatible', raw: response, issues: result.issues }
  }
  return {
    kind: 'decoded',
    variant: result.variant,
    value: result.value,
    raw: response,
    salvage: result.salvage
  }
}

// Applies the operation's declared acceptance policy. Private on purpose: there is no
// free-standing callOrThrow, so no call site can pick a different rule for the same reply.
function interpret(
  operation: AnyRpcOperation,
  settled: RpcRequestOutcome<string, unknown>
): unknown {
  const acceptance: RpcAcceptanceName = operation.acceptance
  switch (acceptance) {
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
  return interpret(operation, settlement.outcome)
}

/** Sends and interprets at the operation's own barrier. Only for barrier 'on-settle'. */
export async function runRpcOperation<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value
>(
  client: RpcClient,
  operation: RpcOperation<Method, Acceptance, Variant, Value, 'on-settle'>,
  params: RpcParams<Method>,
  options?: SendRequestOptions
): Promise<RpcVerdict<Acceptance, Value>> {
  const outcome = await request(client, operation, params, options)
  return interpret(operation, outcome) as RpcVerdict<Acceptance, Value>
}

/** The named opt-in to all-settled semantics. Yields an outcome, never a verdict: the
 *  verdict still comes only from the declared policy, at the declared barrier. */
export async function captureRpcOperationSettlement<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
>(
  client: RpcClient,
  operation: RpcOperation<Method, Acceptance, Variant, Value, Barrier>,
  params: RpcParams<Method>,
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
  client: RpcClient,
  operation: RpcOperation<Method, Acceptance, Variant, Value, 'after-all-requests'>,
  params: RpcParams<Method>,
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
