import { translate } from '../i18n/mobile-i18n'
import { gitCommitCompareRead } from '../source-control/mobile-git-read-operations'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcClient } from '../transport/rpc-client'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'

/** One commit's files, diffed against its parent; notes and viewed state stay with the worktree's changes. */
export async function loadMobileDiffReviewCommitSnapshot(
  client: RpcClient,
  worktreeId: string,
  commitOid: string
): Promise<ReviewScreenState> {
  const reply = await gitCommitCompareRead.request(client, {
    worktree: `id:${worktreeId}`,
    commitId: commitOid
  })
  let compared
  try {
    compared = gitCommitCompareRead.interpret(reply)
  } catch (error) {
    throw new Error(
      refusedRpcMessageOrFallback(
        error,
        translate('session.diffReviewLoaders.commitLoadFailed', 'Unable to load this commit')
      )
    )
  }
  // The host answers a commit it can't resolve (rewritten away, or git failed) with a non-ready summary.
  // Without a summary there is no parent to diff against, and an empty parent would show every line as added.
  const summary = compared.summary
  if (!summary || (summary.status !== undefined && summary.status !== 'ready')) {
    throw new Error(
      summary?.errorMessage ||
        translate('session.diffReviewLoaders.commitLoadFailed', 'Unable to load this commit')
    )
  }
  return {
    kind: 'ready',
    status: { entries: [], conflictOperation: 'unknown' },
    branchCompare: null,
    commit: {
      commitOid,
      parentOid: summary.parentOid ?? null,
      entries: compared.entries
    },
    comments: [],
    reviewState: { version: 1, files: {} }
  }
}
