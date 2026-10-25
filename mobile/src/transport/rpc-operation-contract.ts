import type { RpcAcceptedResult } from './rpc-accepted-result'
import type { RpcMethodName } from './rpc-params-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from './types'

export type { RpcAcceptedResult }

// Fix method, acceptance and interpretation barrier per family so callers cannot drift in decoding or settlement order.

export type RpcAcceptanceName =
  | 'require-result-or-throw'
  | 'object-result-or-null'
  | 'method-not-found-refusal'
  | 'streaming-opener'
  | 'success-result-or-skip'
  | 'require-result-or-throw-message'

export type RpcInterpretationBarrier = 'on-settle' | 'after-all-requests' | 'after-caller-barrier'

export type RpcDecodeIssue = { readonly path: string; readonly message: string }

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

export type RpcCompatibleReader<Raw, Variant extends string, Value> = (
  raw: Raw
) => RpcReadResult<Variant, Value>

export type RpcStreamOpenerReply = RpcSuccess & { streaming: true }

// Leave transport rejection on the promise channel so Promise.all fails immediately instead of changing error precedence.
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
  readonly barrier: Barrier
} & {
  [Policy in RpcAcceptanceName]: {
    readonly acceptance: Policy
    readonly read: Policy extends RpcReaderAcceptance
      ? RpcCompatibleReader<unknown, Variant, Value>
      : undefined
  }
}[Acceptance]

// Internal interpreter view; public send APIs retain the policy/reader correlation.
export type AnyRpcOperation = Pick<
  RpcOperation<RpcMethodName, RpcAcceptanceName, string, unknown, RpcInterpretationBarrier>,
  'name' | 'method' | 'acceptance' | 'barrier'
> & { readonly read: RpcCompatibleReader<unknown, string, unknown> | undefined }

export type RpcVerdict<Acceptance extends RpcAcceptanceName, Value> = Acceptance extends
  | 'require-result-or-throw'
  | 'require-result-or-throw-message'
  ? Value
  : Acceptance extends 'success-result-or-skip'
    ? RpcAcceptedResult<Value>
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
  read: RpcCompatibleReader<Record<string, unknown>, Variant, Value>
}

export type CapabilityProbeRpcDefinition<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'method-not-found-refusal'
  // Refusal probes read no payload.
  read?: never
}

export type StreamOpenerRpcDefinition<
  Method extends RpcMethodName,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: 'streaming-opener'
  // Subscription frames arrive separately; only the opener reply is returned here.
  read?: never
}

export type RpcReaderAcceptance =
  | 'require-result-or-throw'
  | 'object-result-or-null'
  | 'success-result-or-skip'
  | 'require-result-or-throw-message'

export type LegacyResultRpcDefinition<
  Method extends RpcMethodName,
  Acceptance extends 'success-result-or-skip' | 'require-result-or-throw-message',
  Variant extends string,
  Value,
  Barrier extends RpcInterpretationBarrier
> = RpcOperationDefinition<Method, Barrier> & {
  acceptance: Acceptance
  read: RpcCompatibleReader<unknown, Variant, Value>
}
