import type { RpcCompatibleReader, RpcReadResult } from './rpc-operation-contract'

const NOTHING_DROPPED = { droppedPaths: [], droppedCount: 0 } as const

/** A reader answer for a payload no schema rejects: the call site it replaces cast, not parsed. */
export function rpcReadUnchecked<Variant extends string, Value>(
  variant: Variant,
  value: Value
): RpcReadResult<Variant, Value> {
  return { compatible: true, variant, value, salvage: NOTHING_DROPPED }
}

/**
 * One property off a reply payload, preserving the native property-read exception on
 * null/undefined that `(response.result as T).field` threw before the read moved here.
 */
export function rpcPayloadMember(raw: unknown, key: string): unknown {
  const boxed: Record<string, unknown> | null | undefined = raw == null ? raw : Object(raw)

  return boxed![key]
}

/** The whole payload, unchecked. The common shape for a reply a call site only re-typed. */
export function rpcUncheckedPayloadReader<Variant extends string>(
  variant: Variant
): RpcCompatibleReader<unknown, Variant, unknown> {
  return (raw) => rpcReadUnchecked(variant, raw)
}

/** One property off the payload, unchecked. The shape for a call site that cast `result.field`. */
export function rpcUncheckedMemberReader<Variant extends string>(
  variant: Variant,
  key: string
): RpcCompatibleReader<unknown, Variant, unknown> {
  return (raw) => rpcReadUnchecked(variant, rpcPayloadMember(raw, key))
}
