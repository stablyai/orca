import type {
  MobileWebTaskDetailComment,
  MobileWebTaskGitHubDetailResult
} from '../../../src/shared/mobile-web/task-detail-contract'
import type { GitHubPRFileContents } from '../../../src/shared/github/pull-request-types'
import type { HostTaskGitHubItemTarget } from './host-task-item-mutation-operations'

export type HostTaskItemFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged'

export type HostTaskItemFileOperations = {
  refreshChecks(
    target: HostTaskGitHubItemTarget,
    headSha?: string
  ): Promise<MobileWebTaskGitHubDetailResult['checks']>
  rerunChecks(
    target: HostTaskGitHubItemTarget,
    headSha: string | undefined,
    failedOnly: boolean
  ): Promise<void>
  setFileViewed(
    target: HostTaskGitHubItemTarget,
    payload: { pullRequestId: string; path: string; viewed: boolean }
  ): Promise<void>
  loadFileContents(
    target: HostTaskGitHubItemTarget,
    payload: {
      path: string
      oldPath?: string
      status: HostTaskItemFileStatus
      headSha: string
      baseSha: string
    }
  ): Promise<GitHubPRFileContents>
  addInlineComment(
    target: HostTaskGitHubItemTarget,
    payload: { commitId: string; path: string; line: number; body: string }
  ): Promise<MobileWebTaskDetailComment | undefined>
}
