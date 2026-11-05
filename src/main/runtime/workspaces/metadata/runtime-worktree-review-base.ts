import type { GitHubPrStartPoint, GitPushTarget } from '../../../../shared/worktree/types'
import {
  resolveRuntimeGitHubWorktreeBase,
  type RuntimeGitHubWorktreeBaseArgs
} from '../../integrations/github/runtime-github-worktree-base'
import {
  resolveRuntimeGitLabWorktreeBase,
  type RuntimeGitLabWorktreeBaseArgs
} from '../../integrations/gitlab/runtime-gitlab-worktree-base'
import { RuntimeRemoteFetchOperations } from '../../repositories/runtime-remote-fetch-operations'

export abstract class RuntimeWorktreeReviewBase extends RuntimeRemoteFetchOperations {
  async resolveManagedPrBase(
    args: RuntimeGitHubWorktreeBaseArgs
  ): Promise<GitHubPrStartPoint | { error: string }> {
    return resolveRuntimeGitHubWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }

  async resolveManagedMrBase(
    args: RuntimeGitLabWorktreeBaseArgs
  ): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    return resolveRuntimeGitLabWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }
}
