import { ipcMain } from 'electron'
import type { GitHubPrStartPoint, GitPushTarget } from '../../../../shared/worktree/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { gitExecFileAsync } from '../../../git/runner'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../../../project-runtime-git-options'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import {
  fetchPrHeadTrackingRef,
  fetchGitHubPullRequestHeadRef
} from '../../../github/pr-head-tracking-ref'
import { resolveGitHubPrStartPoint } from '../../../github/pr-start-point'
import { resolveGitHubReviewHeadRemote } from '../../../github/review-head-remote'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function registerReviewBaseHandlers(context: WorktreeIpcContext): void {
  const { store, runtime } = context

  ipcMain.handle(
    'worktrees:resolvePrBase',
    async (
      _event,
      args: {
        repoId: string
        prNumber: number
        headRefName?: string
        baseRefName?: string
        isCrossRepository?: boolean
      }
    ): Promise<GitHubPrStartPoint | { error: string }> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { error: 'Repo not found' }
      }
      if (isFolderRepo(repo)) {
        return { error: 'Folder mode does not support creating worktrees.' }
      }
      const gitExec = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
        if (!repo.connectionId) {
          return gitExecFileAsync(args, getLocalProjectGitExecOptions(store, repo))
        }
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          throw new Error(
            'SSH Git provider is not available. Reconnect to this target and try again.'
          )
        }
        return provider.exec(args, repo.path)
      }
      // Why: SSH review-head fetches require narrow write-capable RPCs.
      const fetchRemoteTrackingRef = (remote: string, branch: string): Promise<void> =>
        fetchPrHeadTrackingRef(
          repo,
          repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
          remote,
          branch,
          { localGitExecOptions: getLocalProjectGitExecOptions(store, repo) }
        )
      const fetchPullRequestHeadRef = (remote: string, prNumber: number): Promise<string> =>
        fetchGitHubPullRequestHeadRef(
          repo,
          repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined,
          remote,
          prNumber,
          { localGitExecOptions: getLocalProjectGitExecOptions(store, repo) }
        )

      return resolveGitHubPrStartPoint({
        repoPath: repo.path,
        prNumber: args.prNumber,
        headRefName: args.headRefName,
        baseRefName: args.baseRefName,
        isCrossRepository: args.isCrossRepository,
        issueSourcePreference: repo.issueSourcePreference,
        connectionId: repo.connectionId ?? null,
        localGitOptions: getLocalProjectWorktreeGitOptions(store, repo),
        gitExec,
        fetchRemoteTrackingRef,
        fetchPullRequestHeadRef,
        // Why: one resolver keeps source preference and hosting identity aligned
        // across local, WSL, and SSH worktree creation.
        resolveRemote: () =>
          resolveGitHubReviewHeadRemote({
            repoPath: repo.path,
            issueSourcePreference: repo.issueSourcePreference,
            connectionId: repo.connectionId ?? null,
            localGitOptions: getLocalProjectWorktreeGitOptions(store, repo),
            gitExec
          })
      })
    }
  )

  ipcMain.handle(
    'worktrees:resolveMrBase',
    async (
      _event,
      args: {
        repoId: string
        mrIid: number
        sourceBranch?: string
        targetBranch?: string
        isCrossRepository?: boolean
      }
    ): Promise<
      | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
      | { error: string }
    > => {
      return runtime.resolveManagedMrBase({
        repoSelector: `id:${args.repoId}`,
        mrIid: args.mrIid,
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        isCrossRepository: args.isCrossRepository
      })
    }
  )
}
