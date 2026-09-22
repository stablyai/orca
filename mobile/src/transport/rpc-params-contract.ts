// Why: mobile's only entry to the host's params contract, and type-only on purpose.
// The schemas behind these types must never reach the bundle: requiredString is
// z.unknown().transform(...), so a client-side parse coerces a non-string to ''
// instead of rejecting it, silently changing the bytes on the wire.
//
// RpcSendParams is the outgoing type; RpcParams is the shape the handler sees after
// parsing, which is not what a sender may write (see rpc-send-params.ts).
export type {
  RpcMethodName,
  RpcParams
} from '../../../src/shared/rpc-contract/rpc-params-catalog.generated'
export type { RpcSendParams } from '../../../src/shared/rpc-contract/rpc-send-params'
