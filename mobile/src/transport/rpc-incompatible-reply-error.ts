import type { RpcDecodeIssue } from './rpc-operation-contract'

/** The machine token. `message` is user-facing copy, so callers branch on this or on `name`. */
export const RPC_INCOMPATIBLE_REPLY_CODE = 'incompatible_reply'
const INCOMPATIBLE_REPLY_ERROR_NAME = 'RpcIncompatibleReplyError'

// Why: a reply the operation's reader cannot read says nothing about what the host did.
// On a mutation it is NOT evidence the mutation failed and authorizes no retry — only a
// host-negotiated idempotency capability inside its dedupe window does (see
// tasks/worktree-create-retry.ts). So this error is deliberately neither marked
// delivery-unknown nor shaped like the cutover error the retry loops replay on.
export class RpcIncompatibleReplyError extends Error {
  readonly code = RPC_INCOMPATIBLE_REPLY_CODE

  constructor(
    readonly operationName: string,
    readonly method: string,
    readonly issues: readonly RpcDecodeIssue[]
  ) {
    // Why plain copy: this message reaches toasts and screen error text unchanged.
    super(`The host sent a reply this app could not read (${method})`)
    this.name = INCOMPATIBLE_REPLY_ERROR_NAME
  }
}
