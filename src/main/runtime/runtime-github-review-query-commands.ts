import {
  listActionsArtifacts,
  startActionsArtifactDownload
} from '../github/client/actions/actions-artifacts'
import {
  artifactSessionOwner,
  readArtifactSession,
  releaseArtifactSession
} from '../github/client/actions/artifact-download-sessions'
import type {
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery,
  ActionsArtifactTransferQuery
} from '../../shared/github/actions-artifact-types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type {
  ActionsRunsQuery,
  ActionsWorkflowsQuery,
  ActionsDetailsQuery
} from '../../shared/github/actions-types'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../shared/github/pull-request-types'
import type { Repo } from '../../shared/repo-types'
import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'
import {
  getIssue,
  getPRCheckDetails,
  getPRChecks,
  getPRComments,
  listActionsRuns,
  listActionsWorkflows,
  getWorkflowRunDetails
} from '../github/client'
import { getPRFileContents } from '../github/work-item-details'

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

type RuntimeGitHubReviewQueryCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => LocalGitArgs
}

export class RuntimeGitHubReviewQueryCommands {
  constructor(private readonly deps: RuntimeGitHubReviewQueryCommandsDeps) {}

  /** Resolve an execution-host repository selector and reject folder-only workspaces for GitHub Actions. */
  private async resolveActionsRepo(selector: string): Promise<Repo> {
    const repo = await this.deps.resolveRepo(selector)
    if (isFolderRepo(repo)) {
      throw new Error('Select a registered Git repository for Actions')
    }
    return repo
  }
  /** Read runs with the resolved repository’s SSH/WSL route and the caller’s cancellation signal. */
  async getRepoActionsRuns(selector: string, args: ActionsRunsQuery, signal?: AbortSignal) {
    const repo = await this.resolveActionsRepo(selector)
    return listActionsRuns(
      repo.path,
      args,
      getRepoSshConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      signal
    )
  }
  /** Read workflow pages with the resolved repository’s account and execution route. */
  async getRepoActionsWorkflows(
    selector: string,
    args: ActionsWorkflowsQuery,
    signal?: AbortSignal
  ) {
    const repo = await this.resolveActionsRepo(selector)
    return listActionsWorkflows(
      repo.path,
      args,
      getRepoSshConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      signal
    )
  }
  /** Read attempt-specific jobs using the resolved repository’s route, preserving caller cancellation. */
  async getRepoActionsRunDetails(
    selector: string,
    args: ActionsDetailsQuery,
    signal?: AbortSignal
  ) {
    const repo = await this.resolveActionsRepo(selector)
    return getWorkflowRunDetails(
      repo.path,
      args,
      getRepoSshConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      signal
    )
  }

  /** List artifacts on the resolved Git repository’s execution route rather than the active UI host. */
  async getRepoActionsArtifacts(
    selector: string,
    args: ActionsArtifactsQuery,
    signal?: AbortSignal
  ) {
    const repo = await this.resolveActionsRepo(selector)
    return listActionsArtifacts(
      repo.path,
      args,
      getRepoSshConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      signal
    )
  }
  /** Acquire an owner-bound archive while retaining the caller lifetime beyond the initiating request. */
  async startRepoActionsArtifactDownload(
    selector: string,
    args: ActionsArtifactDownloadQuery,
    signal?: AbortSignal,
    onRelease?: () => void
  ) {
    const repo = await this.resolveActionsRepo(selector)
    return startActionsArtifactDownload(
      repo.path,
      args,
      getRepoSshConnectionId(repo),
      this.deps.getLocalGitArgs(repo)[0],
      signal,
      onRelease
    )
  }
  /** Recompute the repository/host/account owner before reading a retained transfer chunk. */
  async readRepoActionsArtifactChunk(selector: string, args: ActionsArtifactTransferQuery) {
    const repo = await this.resolveActionsRepo(selector)
    return readArtifactSession(
      args.transferId,
      artifactSessionOwner(
        repo.path,
        getRepoSshConnectionId(repo),
        this.deps.getLocalGitArgs(repo)[0]
      ),
      args.offset ?? 0
    )
  }
  /** Recompute transfer ownership before releasing bytes and retained caller-lifetime listeners. */
  async releaseRepoActionsArtifactDownload(selector: string, args: ActionsArtifactTransferQuery) {
    const repo = await this.resolveActionsRepo(selector)
    releaseArtifactSession(
      args.transferId,
      artifactSessionOwner(
        repo.path,
        getRepoSshConnectionId(repo),
        this.deps.getLocalGitArgs(repo)[0]
      )
    )
  }

  async getRepoIssue(
    repoSelector: string,
    number: number
  ): Promise<Awaited<ReturnType<typeof getIssue>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getIssue(
      repo.path,
      number,
      repo.connectionId ?? null,
      ...this.deps.getLocalGitArgs(repo)
    )
  }

  async getRepoPRChecks(
    repoSelector: string,
    prNumber: number,
    headSha?: string,
    prRepo?: GitHubOwnerRepo | null,
    options?: { noCache?: boolean }
  ): Promise<Awaited<ReturnType<typeof getPRChecks>>> {
    const repo = await this.deps.resolveRepo(repoSelector)
    return getPRChecks(
      repo.path,
      prNumber,
      headSha,
      prRepo ?? null,
      options,
      repo.connectionId ?? null,
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
      repo.connectionId ?? null,
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
      repo.connectionId ?? null,
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
      connectionId: repo.connectionId ?? null,
      localGitOptions: this.deps.getLocalGitArgs(repo)[0],
      ...args
    })
  }
}
