import type { RpcDecodeIssue } from './rpc-operation-contract'

const INCOMPATIBLE_REPLY_MESSAGE_PREFIX = 'incompatible_reply: '

// Why: a reply the operation's reader cannot read says nothing about what the host did.
// On a mutation it is NOT evidence the mutation failed and authorizes no retry — only a
// host-negotiated idempotency capability inside its dedupe window does (see
// tasks/worktree-create-retry.ts). So this error is deliberately neither marked
// delivery-unknown nor shaped like the cutover error the retry loops replay on.
export class RpcIncompatibleReplyError extends Error {
  constructor(
    readonly operationName: string,
    readonly method: string,
    readonly issues: readonly RpcDecodeIssue[]
  ) {
    super(`${INCOMPATIBLE_REPLY_MESSAGE_PREFIX}${operationName} (${method})`)
  }
}

// Why: instanceof can miss across bundle copies, so also match by message, mirroring
// isLogicalClientCutoverError.
export function isRpcIncompatibleReplyError(error: unknown): boolean {
  return (
    error instanceof RpcIncompatibleReplyError ||
    (error instanceof Error && error.message.startsWith(INCOMPATIBLE_REPLY_MESSAGE_PREFIX))
  )
}
