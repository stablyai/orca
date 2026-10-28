import { resolveCreatePrIntentRemoteStep } from '../../../src/shared/source-control-create-review-intent'
import type { MobileGitStatusResult } from './mobile-git-status'
import type { MobileHostedReviewCreateIntentProgress } from './mobile-hosted-review-create-intent'
import type { MobilePrPrefill } from './mobile-pr-create'
import {
  fastForwardMobileHostedReviewBranch,
  pushMobileHostedReviewBranch
} from './mobile-hosted-review-git-preparation'
import { readBranchCompareOutcome } from './mobile-branch-compare-outcome'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

type RemotePrerequisiteInput = {
  status: MobileGitStatusResult | null
  onProgress?: (progress: MobileHostedReviewCreateIntentProgress) => void
}

const ALWAYS_CURRENT = { isCurrent: () => true }

// Desktop publishes only a branch with commits beyond its base; read them only when that decides it.
async function readBranchCommitsAhead(
  client: RpcOperationSender,
  worktreeId: string
): Promise<number | undefined> {
  const compare = await readBranchCompareOutcome(client, worktreeId, ALWAYS_CURRENT)
  return compare?.kind === 'ready' && compare.result.summary.status === 'ready'
    ? compare.result.summary.commitsAhead
    : undefined
}

export async function applyMobileHostedReviewRemotePrerequisite(
  client: RpcOperationSender,
  worktreeId: string,
  prefill: MobilePrPrefill,
  input: RemotePrerequisiteInput
): Promise<{ ok: true; ran: boolean } | { ok: false; error: string }> {
  const worktree = `id:${worktreeId}`
  const step = resolveCreatePrIntentRemoteStep({
    upstreamStatus: input.status?.upstreamStatus,
    hostedReviewCreation: prefill,
    branchCommitsAhead:
      prefill.blockedReason === 'no_upstream'
        ? await readBranchCommitsAhead(client, worktreeId)
        : undefined,
    hasCurrentBranch: Boolean(input.status?.branch)
  })
  let result
  switch (step) {
    case 'publish':
      input.onProgress?.('publishing')
      result = await pushMobileHostedReviewBranch(
        client,
        { worktree, publish: true },
        'Failed to publish branch'
      )
      break
    case 'push':
      input.onProgress?.('pushing')
      result = await pushMobileHostedReviewBranch(client, { worktree }, 'Failed to push commits')
      break
    case 'force_push':
      input.onProgress?.('force_pushing')
      result = await pushMobileHostedReviewBranch(
        client,
        { worktree, forceWithLease: true },
        'Failed to force push with lease'
      )
      break
    case 'fast_forward':
      input.onProgress?.('fast_forwarding')
      result = await fastForwardMobileHostedReviewBranch(client, worktreeId)
      break
    case 'blocked':
    case 'none':
      return { ok: true, ran: false }
  }
  return result.ok ? { ok: true, ran: true } : result
}
