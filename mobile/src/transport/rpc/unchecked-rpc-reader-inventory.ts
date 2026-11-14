// The empty inventory forbids new rpcUncheckedPayloadReader, rpcUncheckedMemberReader or rpcReadUnchecked users.
// The boundary scan cannot prove validation in hand-written readers; rpcPayloadMember callers are fenced by the raw-port inventory.
export type UncheckedRpcReaderEntry = {
  readonly file: string
  readonly readers: number
}

// Keep the empty list as the boundary test’s ceiling; decode new readers with rpcResultVariant instead of adding entries.
export const UNCHECKED_RPC_READERS: readonly UncheckedRpcReaderEntry[] = []
