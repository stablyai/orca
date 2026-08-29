import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../shared/git-status-types'
import type { RuntimeGitCheckoutResult, RuntimeGitLocalBranches } from '../../shared/runtime-types'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { checkoutBranch, listLocalBranches } from '../git/checkout'
import { getHistory as getGitHistory } from '../git/history'
import {
  detectConflictOperation,
  getStatus as getGitStatus,
  getSubmoduleStatus as getGitSubmoduleStatus
} from '../git/status'
import type { GitProviderStatusOptions } from '../providers/types'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { localGitOptionsForTarget, type RuntimeGitCommandHost } from './runtime-git-command-target'

export class RuntimeGitStatusCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async getRuntimeGitStatus(
    worktreeSelector: string,
    options?: GitProviderStatusOptions
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return options
        ? provider.getStatus(target.worktree.path, options)
        : provider.getStatus(target.worktree.path)
    }
    const gitOptions = localGitOptionsForTarget(target)
    // Why: shared symlinks do not match Git's directory-only ignore rules.
    const sharedLinkPaths = target.repo ? getWorktreeSharedLinkPaths(target.repo) : []
    const sharedOptions = sharedLinkPaths.length > 0 ? { sharedLinkPaths } : {}
    return options
      ? getGitStatus(target.worktree.path, { ...options, ...gitOptions, ...sharedOptions })
      : getGitStatus(target.worktree.path, { ...gitOptions, ...sharedOptions })
  }

  async getRuntimeGitSubmoduleStatus(
    worktreeSelector: string,
    submodulePath: string,
    area: GitStagingArea = 'unstaged'
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getSubmoduleStatus(target.worktree.path, submodulePath, area)
    }
    return getGitSubmoduleStatus(target.worktree.path, submodulePath, {
      ...localGitOptionsForTarget(target),
      ...(area === 'staged' ? { staged: true } : {})
    })
  }

  async checkRuntimeGitIgnoredPaths(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.checkIgnoredPaths(target.worktree.path, relativePaths)
    }
    return checkIgnoredPaths(target.worktree.path, relativePaths, localGitOptionsForTarget(target))
  }

  async getRuntimeGitHistory(
    worktreeSelector: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getHistory(target.worktree.path, options)
    }
    return getGitHistory(target.worktree.path, {
      ...options,
      ...localGitOptionsForTarget(target)
    })
  }

  async getRuntimeGitConflictOperation(worktreeSelector: string): Promise<GitConflictOperation> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.detectConflictOperation(target.worktree.path)
    }
    return detectConflictOperation(target.worktree.path)
  }

  async checkoutRuntimeGitBranch(
    worktreeSelector: string,
    branch: string
  ): Promise<RuntimeGitCheckoutResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.checkoutBranch(target.worktree.path, branch)
      return { ok: true, branch }
    }
    await checkoutBranch(target.worktree.path, branch, localGitOptionsForTarget(target))
    return { ok: true, branch }
  }

  async listRuntimeGitLocalBranches(worktreeSelector: string): Promise<RuntimeGitLocalBranches> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshGitProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.listLocalBranches(target.worktree.path)
    }
    return listLocalBranches(target.worktree.path, localGitOptionsForTarget(target))
  }
}
