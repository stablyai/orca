import type {
  MobileWebTaskDetailComment,
  MobileWebTaskGitHubDetailResult
} from '../../../src/shared/mobile-web/task-detail-contract'
import type { GitHubPRFileContents } from '../../../src/shared/github/pull-request-types'
import type { HostTaskProjectItemTarget } from './host-task-project-mutation-operations'

export type HostTaskProjectFileOperations = {
  refreshChecks(
    target: HostTaskProjectItemTarget,
    repoId: string,
    headSha?: string
  ): Promise<MobileWebTaskGitHubDetailResult['checks']>
  setFileViewed(
    target: HostTaskProjectItemTarget,
    repoId: string,
    payload: { pullRequestId: string; path: string; viewed: boolean }
  ): Promise<void>
  loadFileContents(
    target: HostTaskProjectItemTarget,
    repoId: string,
    payload: {
      path: string
      oldPath?: string
      status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
      headSha: string
      baseSha: string
    }
  ): Promise<GitHubPRFileContents>
  addInlineComment(
    target: HostTaskProjectItemTarget,
    repoId: string,
    payload: { commitId: string; path: string; line: number; body: string }
  ): Promise<MobileWebTaskDetailComment | undefined>
}
