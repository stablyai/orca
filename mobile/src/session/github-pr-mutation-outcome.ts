import type { RpcMethodName } from '../transport/rpc-params-contract'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import type { GitHubPrMutationStatus } from './github-pr-mutation-operations'

// How a `github.*` PR mutation's reply becomes the one outcome the action engine routes on. The
// two settle shapes below are the two reply contracts the host uses, and they differ in one place
// that matters: what an empty failure message becomes.

export type GitHubPrMutationOutcome = { ok: true } | { ok: false; error: string }

// Host failure `error` is either a bare string (github.* PR mutations) or an
// object `{ message }` (github.project.* slug mutations). Read whichever is present
// so the slug edit/delete failures surface a real message, not a generic fallback.
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

/** As much of a bound operation as a settle shape needs; the read settle takes the same shape. */
export type GitHubPrSettleableOperation<Value> = {
  readonly operation: { readonly method: RpcMethodName }
  readonly interpret: (reply: RpcResponse) => Value
}

/**
 * The status-envelope mutations. Two catches, because main had two paths: a transport drop
 * surfaces its own message verbatim, empty included, while a refusal with no message falls back to
 * the method's copy. The transport rejection reaches this catch as the original object, so the
 * delivery-unknown mark it carries is intact for anything that later asks — nothing here retries,
 * and a dropped reply is never read as evidence the mutation failed to reach the host.
 */
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
  // No structured status (host returned void/undefined) — treat as success.
  if (!status.structured || status.ok === true) {
    return { ok: true }
  }
  return { ok: false, error: extractMutationError(status.error, method) }
}

/**
 * The two mutations whose host result is a bare boolean.
 *
 * Both catches fall back here, unlike the status-envelope shape above: main sent these through
 * `sendRaw`, whose empty message was then replaced by the wrapper's own `|| 'Request failed: …'`,
 * so an empty transport message never reached the caller on this path.
 */
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
  // Why: the host returns a bare `true` on success; a missing/undefined result is
  // not a confirmed success, so require an explicit `=== true` rather than `!== false`.
  return confirmation === true ? { ok: true } : { ok: false, error: unconfirmed }
}
