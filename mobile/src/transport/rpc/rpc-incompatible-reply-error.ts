import type { RpcDecodeIssue } from './rpc-operation-contract'

/** The machine token. `message` is user-facing copy, so callers branch on this or on `name`. */
export const RPC_INCOMPATIBLE_REPLY_CODE = 'incompatible_reply'
const INCOMPATIBLE_REPLY_ERROR_NAME = 'RpcIncompatibleReplyError'

// Unreadable mutation replies prove no failure and authorize no retry without negotiated idempotency inside its dedupe window.
// Keep this distinct from delivery-unknown and cutover errors that retry loops recognize.
export class RpcIncompatibleReplyError extends Error {
  readonly code = RPC_INCOMPATIBLE_REPLY_CODE

  constructor(
    readonly operationName: string,
    readonly method: string,
    readonly issues: readonly RpcDecodeIssue[]
  ) {
    // This message reaches screen text and toasts unchanged.
    super(`The host sent a reply this app could not read (${method})`)
    this.name = INCOMPATIBLE_REPLY_ERROR_NAME
  }
}
