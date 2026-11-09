import { getGitHubApiRepositoryForRemote } from '../../github/github-api-repository'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { HOSTED_REVIEW_LINK_KEYS } from '../../../shared/worktree/hosted-review-links'
import { withCheckoutLock } from '../../git/branch-switch'
import type { WorktreeMetadataUpdateGuard } from '../workspaces/metadata/runtime-managed-worktree-metadata'
import type { WorkspaceAttachment, GitPushTarget } from '../../../shared/worktree/types'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import type { PRWatchWorkspace } from '../../github/pr-watch/pr-watch-types'
import { hostedReviewSshConnectionId } from '../../source-control/hosted-review-execution-host'
import type { ProjectRuntimeResolutionStore } from '../../workspaces/execution-host/local-project-runtime-resolution'
import {
  getLocalProjectGhExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../../workspaces/execution-host/project-runtime-git-options'
import {
  adoptPublishedPRBranch,
  type PublishedBranchWorkspace
} from './pr-published-branch-adoption'
import type { PRWatchRuntimeDeps } from './pr-watch-runtime'

type WorkspaceSourcesRuntime = {
  resolveRuntimeFileTarget(selector: string): Promise<{
    worktree: PublishedBranchWorkspace & { repoId: string; path: string }
    executionHostId: ExecutionHostId
  }>
  updateManagedWorktreeMeta(
    selector: string,
    updates: { pushTarget: GitPushTarget; linkedPR: number; linkedItems: WorkspaceAttachment[] },
    guard: WorktreeMetadataUpdateGuard
  ): Promise<unknown>
  store: () => ProjectRuntimeResolutionStore & { getRepo(repoId: string): Repo | undefined }
}

function repoSource(
  runtime: WorkspaceSourcesRuntime,
  repo: Repo,
  executionHostId: ExecutionHostId
): Omit<PRWatchWorkspace, 'branch' | 'checkoutPath'> {
  const { wslDistro } = getLocalProjectWorktreeGitOptions(runtime.store(), repo)
  return {
    repoId: repo.id,
    repoPath: repo.path,
    repoKind: repo.kind ?? 'git',
    connectionId: hostedReviewSshConnectionId(executionHostId),
    ...(wslDistro ? { wslDistro } : {})
  }
}

/** A chat's checkout, for the host's CI-line watches. */
export function prWatchWorkspaceSources(
  runtime: WorkspaceSourcesRuntime
): Pick<PRWatchRuntimeDeps, 'resolveWorkspace' | 'adoptPublishedBranch'> {
  return {
    resolveWorkspace: async (workspaceId) => {
      const { worktree, executionHostId } = await runtime.resolveRuntimeFileTarget(
        `id:${workspaceId}`
      )
      const repo = runtime.store().getRepo(worktree.repoId)
      const branch = worktree.git.branch.replace(/^refs\/heads\//u, '')
      if (repo?.kind === 'folder') {
        return 'not-git'
      }
      // A detached checkout stays usable: pushes name their branch and created PRs their number.
      if (!repo) {
        return null
      }
      return { ...repoSource(runtime, repo, executionHostId), checkoutPath: worktree.path, branch }
    },
    adoptPublishedBranch: async (workspaceId, published) => {
      const selector = `id:${workspaceId}`
      const { worktree, executionHostId } = await runtime.resolveRuntimeFileTarget(selector)
      const repo = runtime.store().getRepo(worktree.repoId)
      if (!repo || repo.kind === 'folder' || hostedReviewSshConnectionId(executionHostId)) {
        return
      }
      const gitOptions = {
        cwd: worktree.path,
        ...getLocalProjectWorktreeGitOptions(runtime.store(), repo)
      }
      const expected = JSON.stringify([
        worktree.pushTarget,
        ...HOSTED_REVIEW_LINK_KEYS.map((key) => worktree[key] ?? null),
        worktree.suppressedGitHubPR ?? null,
        worktree.linkedItems
      ])
      await adoptPublishedPRBranch({
        worktree,
        published,
        execGit: (args) => gitExecFileAsync(args, gitOptions),
        resolveRemote: (remoteName) =>
          getGitHubApiRepositoryForRemote(
            worktree.path,
            remoteName,
            null,
            getLocalProjectGhExecOptions(runtime.store(), repo)
          ),
        update: (updates, validateCheckout) =>
          withCheckoutLock(worktree.path, () =>
            runtime.updateManagedWorktreeMeta(selector, updates, {
              validate: validateCheckout,
              matches: (current) =>
                JSON.stringify([
                  current?.pushTarget,
                  ...HOSTED_REVIEW_LINK_KEYS.map((key) => current?.[key] ?? null),
                  current?.suppressedGitHubPR ?? null,
                  current?.linkedItems
                ]) === expected
            })
          )
      })
    }
  }
}
