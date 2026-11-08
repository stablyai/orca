import { translate } from '../i18n/mobile-i18n'
import type { RpcOperationSender } from '../transport/rpc/rpc-operation-sender'
import { refusedRpcMessageOrFallback } from '../transport/rpc/rpc-refusal-message'
import {
  resolveMobileBranchBaseRefs,
  type MobileBranchBaseRefs,
  type MobileBranchCompareTarget
} from './mobile-branch-base-ref'
import { gitBranchCompareRead } from './mobile-git-read-operations'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'

export type BranchCompareOutcome =
  | { readonly kind: 'ready'; readonly result: MobileGitBranchCompareReply }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

// Every attempt reports the rebase target it resolved, whether or not the compare itself worked.
export type BranchCompareAttempt = BranchCompareOutcome & {
  readonly effectiveBaseRef: string | null
}

// Return failures because callers void this load.
export async function readBranchCompareOutcome(
  client: RpcOperationSender,
  worktreeId: string,
  compare?: MobileBranchCompareTarget
): Promise<BranchCompareAttempt> {
  let baseRefs: MobileBranchBaseRefs
  try {
    baseRefs = await resolveMobileBranchBaseRefs(client, worktreeId, compare)
  } catch (err) {
    return { ...failedCompare(err), effectiveBaseRef: null }
  }
  const [outcome, effectiveBaseRef] = await Promise.all([
    readCompare(client, worktreeId, baseRefs.compareBaseRef),
    baseRefs.readEffectiveBaseRef()
  ])
  return { ...outcome, effectiveBaseRef }
}

async function readCompare(
  client: RpcOperationSender,
  worktreeId: string,
  baseRef: string | null
): Promise<BranchCompareOutcome> {
  if (!baseRef) {
    return {
      kind: 'failed',
      message: translate(
        'sourceControl.branchCompareOutcome.baseBranchUnavailable',
        'Unable to resolve the base branch for comparison.'
      )
    }
  }
  try {
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
        message: refusedRpcMessageOrFallback(
          error,
          translate(
            'sourceControl.branchCompareOutcome.loadFailed',
            'Unable to load committed changes'
          )
        )
      }
    }
  } catch (err) {
    return failedCompare(err)
  }
}

function failedCompare(err: unknown): BranchCompareOutcome {
  return {
    kind: 'failed',
    message:
      err instanceof Error
        ? err.message
        : translate(
            'sourceControl.branchCompareOutcome.loadFailed',
            'Unable to load committed changes'
          )
  }
}
