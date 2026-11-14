import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { GitHubPRFile } from '../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { getIssue } from '../../../github/issues/issues'
import { getPRCheckDetails } from '../../../github/client/check/get-pr-check-details'
import { getPRChecks } from '../../../github/client/check/get-pr-checks'
import { getPRComments } from '../../../github/client/fetch/get-pr-comments'
import { getPRFileContents } from '../../../github/pull-requests/files/pull-request-file-contents'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import type { GitHubPRRefreshReason } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

type RuntimeGitHubReviewQueryCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubReviewQueryCommands {
  constructor(private readonly deps: RuntimeGitHubReviewQueryCommandsDeps) {}

  async getRepoIssue(
    repoSelector: string,
    number: number
  ): Promise<Awaited<ReturnType<typeof getIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getIssue(
      repo.path,
      number,
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    headSha?: string,
    prRepo?: GitHubOwnerRepo | null,
    options?: {
      noCache?: boolean
      userRefresh?: boolean
      reason?: GitHubPRRefreshReason
    }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const { reason, ...readOptions } = options ?? {}
    return getPRChecks(
      repo.path,
      prNumber,
      headSha,
      prRepo ?? null,
      // Only a client's timer is capped by this host's cadence; other reasons stay fresh.
      { ...readOptions, timed: reason === 'swr' },
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRCheckDetails(
    repoSelector: string,
    args: {
      checkRunId?: number
      workflowRunId?: number
      checkName?: string
      url?: string | null
      prRepo?: GitHubOwnerRepo | null
    },
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<typeof getPRCheckDetails>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const localGitOptions = this.deps.getLocalGitArgs(repo)[0] ?? {}
    return getPRCheckDetails(
      repo.path,
      { ...args, prRepo: args.prRepo ?? null },
      getRepoRoutingConnectionId(repo),
      localGitOptions,
      signal
    )
  }

  async getRepoPRComments(
    repoSelector: string,
    prNumber: number,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRComments>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRComments(
      repo.path,
      prNumber,
      { ...options, prRepo: prRepo ?? null },
      getRepoRoutingConnectionId(repo),
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRFileContents(
    repoSelector: string,
    args: {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ): Promise<Awaited<ReturnType<typeof getPRFileContents>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRFileContents({
      repoPath: repo.path,
      connectionId: getRepoRoutingConnectionId(repo),
      localGitOptions: this.deps.getLocalGitArgs(repo)[0],
      ...args
    })
  }
}
