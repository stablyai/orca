import type { RpcCompatibleReader, RpcReadResult } from './rpc-operation-contract'

const NOTHING_DROPPED = { droppedPaths: [], droppedCount: 0 } as const

// Unchecked readers declare compatibility without validating the payload.
export function rpcReadUnchecked<Variant extends string, Value>(
  variant: Variant,
  value: Value
): RpcReadResult<Variant, Value> {
  return { compatible: true, variant, value, salvage: NOTHING_DROPPED }
}

// Preserve native property-read exceptions on null/undefined.
export function rpcPayloadMember(raw: unknown, key: string): unknown {
  const boxed: Record<string, unknown> | null | undefined = raw == null ? raw : Object(raw)
  return boxed![key]
}

export function rpcUncheckedPayloadReader<Variant extends string>(
  variant: Variant
): RpcCompatibleReader<unknown, Variant, unknown> {
  return (raw) => rpcReadUnchecked(variant, raw)
}

export function rpcUncheckedMemberReader<Variant extends string>(
  variant: Variant,
  key: string
): RpcCompatibleReader<unknown, Variant, unknown> {
  return (raw) => rpcReadUnchecked(variant, rpcPayloadMember(raw, key))
}
