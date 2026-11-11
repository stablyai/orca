import type { GitHubOwnerRepo, GitHubPRFile } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { getIssue } from '../../../github/issues'
import { getPRCheckDetails } from '../../../github/client/check/get-pr-check-details'
import { getPRChecks } from '../../../github/client/check/get-pr-checks'
import { getPRComments } from '../../../github/client/fetch/get-pr-comments'
import { getPRFileContents } from '../../../github/work-item-details'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import type { GitHubPRRefreshReason } from '../../../../shared/github/pull-request-refresh-types'
import { getPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { isBudgetedBackground } from '../../../github/pr-refresh-candidate-policy'
import {
  pacedPRChecksKey,
  readPacedPRChecks,
  recordPRChecksRead,
  startPRChecksRead
} from '../../../github/client/check/pr-checks-last-outcome'

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
      foreground?: boolean
    }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const connectionId = getRepoRoutingConnectionId(repo)
    const localGitArgs = this.deps.getLocalGitArgs(repo)
    const read = () =>
      getPRChecks(
        repo.path,
        prNumber,
        headSha,
        prRepo ?? null,
        options,
        connectionId,
        ...localGitArgs
      )
    // A client's timed checks read is capped by this host's cadence like its PR read; an opened panel,
    // a returned window, a refresh and a changed-state read (noCache) still go to the provider.
    const timed =
      options?.reason !== undefined &&
      isBudgetedBackground(options.reason) &&
      options.foreground !== true &&
      options.userRefresh !== true &&
      options.noCache !== true
    const key = pacedPRChecksKey(
      repo.path,
      connectionId,
      prNumber,
      headSha,
      prRepo ?? null,
      localGitArgs[0] ?? {}
    )
    if (timed) {
      const paced = readPacedPRChecks(key, getPRAutoRefreshCadence())
      if (paced) {
        return paced
      }
    }
    // Every successful full read becomes the host's last answer, so a foreground or manual read
    // never loses to the older timed one a later timed client would otherwise be handed back.
    // The start sequence keeps an older read that settles later from replacing a newer answer.
    const start = startPRChecksRead()
    const checks = await read()
    recordPRChecksRead(key, start, checks)
    return checks
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
