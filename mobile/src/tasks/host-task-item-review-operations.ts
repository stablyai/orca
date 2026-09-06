import type { MobileWebTaskDetailComment } from '../../../src/shared/mobile-web/task-detail-contract'
import type { HostTaskItemMutationTarget } from './host-task-item-mutation-operations'

type GitHubTarget = Extract<HostTaskItemMutationTarget, { provider: 'github' }>
export type HostTaskReviewMergeMethod = 'merge' | 'squash' | 'rebase'

export type HostTaskItemReviewOperations = {
  addComment(
    target: HostTaskItemMutationTarget,
    body: string
  ): Promise<MobileWebTaskDetailComment | undefined>
  requestReviewers(target: GitHubTarget, reviewers: string[]): Promise<void>
  resolveThread(target: GitHubTarget, threadId: string, resolve: boolean): Promise<void>
  replyReviewComment(
    target: GitHubTarget,
    payload: {
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
    }
    // Why: the server comment carries the real id; a local stub id fails the numeric-id check
    // that routes a follow-up reply back to the same review thread.
  ): Promise<MobileWebTaskDetailComment | undefined>
  merge(target: HostTaskItemMutationTarget, method: HostTaskReviewMergeMethod): Promise<void>
}
