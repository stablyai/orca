import type { RpcMethodName } from '../transport/rpc-params-contract'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import type { GitHubPrMutationStatus } from './github-pr-mutation-operations'

export type GitHubPrMutationOutcome = { ok: true } | { ok: false; error: string }

// PR mutations return error strings; project slug mutations return message objects. Preserve either host explanation.
function extractMutationError(error: unknown, method: string): string {
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  return `Request failed: ${method}`
}

export type GitHubPrSettleableOperation<Value> = {
  readonly operation: { readonly method: RpcMethodName }
  readonly interpret: (reply: RpcResponse) => Value
}

// Transport errors preserve even empty messages; in-band refusals use method fallback text. Never infer nondelivery or retry from a dropped reply.
export async function settleGithubPrMutation(
  mutation: GitHubPrSettleableOperation<GitHubPrMutationStatus>,
  send: () => Promise<RpcResponse>
): Promise<GitHubPrMutationOutcome> {
  const method = mutation.operation.method
  const fallback = `Request failed: ${method}`
  let reply: RpcResponse
  try {
    reply = await send()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback }
  }
  let status: GitHubPrMutationStatus
  try {
    status = mutation.interpret(reply)
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, fallback) }
  }
  if (!status.structured || status.ok === true) {
    return { ok: true }
  }
  return { ok: false, error: extractMutationError(status.error, method) }
}

// Boolean-confirmation methods retain the legacy fallback for empty transport/refusal messages.
export async function settleGithubPrConfirmation(
  mutation: GitHubPrSettleableOperation<unknown>,
  send: () => Promise<RpcResponse>,
  unconfirmed: string
): Promise<GitHubPrMutationOutcome> {
  const fallback = `Request failed: ${mutation.operation.method}`
  let reply: RpcResponse
  try {
    reply = await send()
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, fallback) }
  }
  let confirmation: unknown
  try {
    confirmation = mutation.interpret(reply)
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, fallback) }
  }
  // Only true confirms success; undefined is unconfirmed.
  return confirmation === true ? { ok: true } : { ok: false, error: unconfirmed }
}
