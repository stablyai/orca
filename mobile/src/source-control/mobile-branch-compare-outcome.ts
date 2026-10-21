import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RequestCurrency } from '../transport/generation-scoped-request-owner'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import { gitBranchCompareRead } from './mobile-git-read-operations'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'
import type { MobileBranchCompareState } from './mobile-source-control-screen-state'

// The compare leg's own protocol and screen mapping: what one attempt against the worktree's base
// can end as, and what each ending leaves on screen. Nothing here reaches React.

/**
 * Every end one compare attempt can reach, its failures included. The attempt returns its outcome
 * instead of writing it, so the screen is written in exactly one place: past the owner's `commit`.
 */
export type BranchCompareOutcome =
  | { readonly kind: 'ready'; readonly result: MobileGitBranchCompareReply }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Total by construction: a throw here would reach a caller that only ever voids this load. Null is
 * the superseded answer, which the owner reads as no value at all.
 */
export async function readBranchCompareOutcome(
  client: RpcOperationSender,
  worktreeId: string,
  currency: RequestCurrency
): Promise<BranchCompareOutcome | null> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
    // Resolving the base ref is itself a round trip, so the scope may have moved while it was out.
    // Stopping here is what keeps a superseded attempt's compare off the wire: refusing it at commit
    // would be just as safe on screen but would have sent the request.
    if (!currency.isCurrent()) {
      return null
    }
    if (!baseRef) {
      return { kind: 'failed', message: 'Unable to resolve the base branch for comparison.' }
    }
    const reply = await gitBranchCompareRead.request(client, {
      worktree: `id:${worktreeId}`,
      baseRef
    })
    // Why the raw refusal: a host that does not offer git to mobile is a capability gap this
    // screen degrades on, and no acceptance policy carries the code and message through.
    if (isMobileGitUnavailableReply(reply)) {
      return { kind: 'unavailable' }
    }
    try {
      return { kind: 'ready', result: gitBranchCompareRead.interpret(reply) }
    } catch (error) {
      return {
        kind: 'failed',
        message: refusedRpcMessageOrFallback(error, 'Unable to load committed changes')
      }
    }
  } catch (err) {
    return {
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Unable to load committed changes'
    }
  }
}

/** What an outcome leaves on screen, given what this caller wants kept when the attempt fails. */
export function nextBranchCompareState(
  outcome: BranchCompareOutcome,
  previous: MobileBranchCompareState,
  preserveReadyOnFailure: boolean
): MobileBranchCompareState {
  if (outcome.kind === 'ready') {
    return { kind: 'ready', result: outcome.result }
  }
  // Why: wiping a prior ready compare to idle makes Changes say "No Changes" even when commits
  // still exist (e.g. after abort-merge refresh).
  if (preserveReadyOnFailure && previous.kind === 'ready') {
    return previous
  }
  return outcome.kind === 'unavailable'
    ? { kind: 'idle' }
    : { kind: 'error', message: outcome.message }
}
