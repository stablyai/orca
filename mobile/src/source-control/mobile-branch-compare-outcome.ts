import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RequestCurrency } from '../transport/generation-scoped-request-owner'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import { gitBranchCompareRead } from './mobile-git-read-operations'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'
import type { MobileBranchCompareState } from './mobile-source-control-screen-state'

export type BranchCompareOutcome =
  | { readonly kind: 'ready'; readonly result: MobileGitBranchCompareReply }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

// Return failures because callers void this load; null means superseded and publishes nothing.
export async function readBranchCompareOutcome(
  client: RpcOperationSender,
  worktreeId: string,
  currency: RequestCurrency
): Promise<BranchCompareOutcome | null> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
    // Base resolution can outlive its scope; stop before sending a superseded compare request.
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
    // Inspect raw refusal to degrade on missing git capability.
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

export function nextBranchCompareState(
  outcome: BranchCompareOutcome,
  previous: MobileBranchCompareState,
  preserveReadyOnFailure: boolean
): MobileBranchCompareState {
  if (outcome.kind === 'ready') {
    return { kind: 'ready', result: outcome.result }
  }
  // Clearing ready state to idle would claim No Changes despite retained branch commits.
  if (preserveReadyOnFailure && previous.kind === 'ready') {
    return previous
  }
  return outcome.kind === 'unavailable'
    ? { kind: 'idle' }
    : { kind: 'error', message: outcome.message }
}
