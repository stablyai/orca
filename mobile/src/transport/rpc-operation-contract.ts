import type { RpcMethodName } from './rpc-params-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from './types'

// An operation descriptor fixes the method, the acceptance policy and the interpretation
// barrier at definition time. Per-call freedom over those three is what produced acceptance
// drift and settlement-order drift across mobile's RPC call sites, so none of them is a
// parameter of any send helper.

/** One of the named policies in rpc-acceptance-policies.ts, chosen per operation family. */
export type RpcAcceptanceName =
  | 'require-result-or-throw'
  | 'object-result-or-null'
  | 'method-not-found-refusal'
  | 'streaming-opener'

/** Where a settled reply may become a value or a throw. */
export type RpcInterpretationBarrier = 'on-settle' | 'after-all-requests'

export type RpcDecodeIssue = { readonly path: string; readonly message: string }

/** Bounded salvage diagnostics for a reply that decoded with parts dropped. */
export type RpcSalvageReport = {
  readonly droppedPaths: readonly string[]
  readonly droppedCount: number
}

export type RpcReadResult<Variant extends string, Value> =
  | {
      readonly compatible: true
      readonly variant: Variant
      readonly value: Value
      readonly salvage: RpcSalvageReport
    }
  | { readonly compatible: false; readonly issues: readonly RpcDecodeIssue[] }

/** Reads the payload its acceptance policy admits into one declared semantic variant. */
export type RpcCompatibleReader<Raw, Variant extends string, Value> = (
  raw: Raw
) => RpcReadResult<Variant, Value>

export type RpcStreamOpenerReply = RpcSuccess & { streaming: true }

// Only a fulfilled outer envelope is classified. Transport rejection stays on the promise
// channel, so an operation in a Promise.all still fails the group immediately instead of
// waiting for a peer and letting a later policy surface a different error.
export type RpcRequestOutcome<Variant extends string, Value> =
  | {
      readonly kind: 'outer-refused'
      readonly error: RpcFailure['error']
      readonly raw: RpcResponse
    }
  | {
      readonly kind: 'decoded'
      readonly variant: Variant
      readonly value: Value
      readonly raw: RpcResponse
      readonly salvage: RpcSalvageReport
    }
  | {
      readonly kind: 'incompatible'
      readonly raw: RpcResponse
      readonly issues: readonly RpcDecodeIssue[]
    }

export type RpcOperation<
  Method extends RpcMethodName,
  Acceptance extends RpcAcceptanceName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
> = {
  /** Family name, not the method: two families may share a method with different acceptance. */
  readonly name: string
  readonly method: Method
  readonly acceptance: Acceptance
  readonly barrier: Barrier
  /** Reply fields this family reads — the host contract a wire change has to respect. */
  readonly consumes: readonly string[]
  /** Refresh/poll schedules this family owns; empty when it only runs on user intent. */
  readonly schedules: readonly string[]
  /** Absent for policies that read no result payload. */
  readonly read?: RpcCompatibleReader<unknown, Variant, Value>
}

// Covariant top type: an operation's reader may narrow the variant and the value.
export type AnyRpcOperation = RpcOperation<
  RpcMethodName,
  RpcAcceptanceName,
  string,
  unknown,
  RpcInterpretationBarrier
>

/** The verdict the declared policy yields. Not a per-call choice. */
export type RpcVerdict<
  Acceptance extends RpcAcceptanceName,
  Value
> = Acceptance extends 'require-result-or-throw'
  ? Value
  : Acceptance extends 'object-result-or-null'
    ? Value | null
    : Acceptance extends 'method-not-found-refusal'
      ? boolean
      : Acceptance extends 'streaming-opener'
        ? RpcStreamOpenerReply | null
        : never

export type RpcOperationSettlement<Variant extends string, Value> =
  | { readonly status: 'fulfilled'; readonly outcome: RpcRequestOutcome<Variant, Value> }
  | { readonly status: 'rejected'; readonly error: unknown }

type RpcOperationDefinition<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
> = {
  name: string
  method: Method
  barrier: Barrier
  consumes: readonly string[]
  schedules: readonly string[]
}

export type RequireResultRpcDefinition<
  Method extends RpcMethodName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'require-result-or-throw'
  read: RpcCompatibleReader<unknown, Variant, Value>
}

export type ObjectResultRpcDefinition<
  Method extends RpcMethodName,
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'object-result-or-null'
  // Raw is the non-null object rpcObjectResultOrNull admits; anything else is incompatible.
  read: RpcCompatibleReader<Record<string, unknown>, Variant, Value>
}

export type CapabilityProbeRpcDefinition<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'method-not-found-refusal'
  /** A probe answers from the refusal code alone, so a reader would have nothing to read. */
  read?: never
}

export type StreamOpenerRpcDefinition<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'streaming-opener'
  /** The opener's value is the reply itself; frames arrive on the subscription, not here. */
  read?: never
}
