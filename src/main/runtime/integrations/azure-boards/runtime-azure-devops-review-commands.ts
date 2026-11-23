import type {
  AzureDevOpsPrCheck,
  AzureDevOpsPrDetail,
  AzureDevOpsPrFiles,
  AzureDevOpsPrSummary,
  AzureDevOpsPrThread
} from '../../../../shared/azure-devops/azure-devops-pr-review-types'
import {
  listAzureDevOpsPullRequestChecks,
  listAzureDevOpsPullRequestFiles,
  listAzureDevOpsPullRequestThreads
} from '../../../azure-devops/pull-request-review/pr-review-activity-client'
import {
  getAzureDevOpsPullRequestDetail,
  listAzureDevOpsActivePullRequestsForBranch,
  listAzureDevOpsPullRequestsAwaitingMyReview,
  locateAzureDevOpsPullRequest
} from '../../../azure-devops/pull-request-review/pr-review-read-client'
import {
  resolveAzureDevOpsRepoSelector,
  type RuntimeAzureBoardsCommandsDeps
} from './runtime-azure-boards-commands'

/** Read-only Azure DevOps pull request review data for agents; nothing here votes or comments. */
export class RuntimeAzureDevOpsReviewCommands {
  constructor(private readonly deps: RuntimeAzureBoardsCommandsDeps) {}

  async listAzureDevOpsPrsAwaitingReview(repoSelector: string): Promise<AzureDevOpsPrSummary[]> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return listAzureDevOpsPullRequestsAwaitingMyReview(repo)
  }

  async listAzureDevOpsPrsForBranch(
    repoSelector: string,
    branch: string
  ): Promise<AzureDevOpsPrSummary[]> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return listAzureDevOpsActivePullRequestsForBranch(repo, branch)
  }

  async getAzureDevOpsPr(repoSelector: string, id: number): Promise<AzureDevOpsPrDetail | null> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return (await getAzureDevOpsPullRequestDetail(repo, id))?.detail ?? null
  }

  async listAzureDevOpsPrThreads(repoSelector: string, id: number): Promise<AzureDevOpsPrThread[]> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return listAzureDevOpsPullRequestThreads(await locateAzureDevOpsPullRequest(repo, id), id)
  }

  async listAzureDevOpsPrChecks(repoSelector: string, id: number): Promise<AzureDevOpsPrCheck[]> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return listAzureDevOpsPullRequestChecks(await locateAzureDevOpsPullRequest(repo, id), id)
  }

  async listAzureDevOpsPrFiles(
    repoSelector: string,
    id: number,
    sinceIteration?: number
  ): Promise<AzureDevOpsPrFiles> {
    const repo = await resolveAzureDevOpsRepoSelector(this.deps, repoSelector)
    return listAzureDevOpsPullRequestFiles(
      await locateAzureDevOpsPullRequest(repo, id),
      id,
      sinceIteration
    )
  }
}
