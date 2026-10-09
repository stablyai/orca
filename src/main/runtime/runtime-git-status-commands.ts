import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type {
  GitConflictOperation,
  GitStagingArea,
  GitStatusResult
} from '../../shared/git-status-types'
import type { RuntimeGitCheckoutResult, RuntimeGitLocalBranches } from '../../shared/runtime-types'
import type { GitProviderStatusOptions } from '../providers/types'
import { requireRuntimeGitProvider, type RuntimeGitCommandHost } from './runtime-git-command-target'

export class RuntimeGitStatusCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async getRuntimeGitStatus(
    worktreeSelector: string,
    options?: GitProviderStatusOptions
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    return options
      ? provider.getStatus(target.worktree.path, options)
      : provider.getStatus(target.worktree.path)
  }

  async getRuntimeGitSubmoduleStatus(
    worktreeSelector: string,
    submodulePath: string,
    area: GitStagingArea = 'unstaged'
  ): Promise<GitStatusResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getSubmoduleStatus(
      target.worktree.path,
      submodulePath,
      area
    )
  }

  async checkRuntimeGitIgnoredPaths(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).checkIgnoredPaths(target.worktree.path, relativePaths)
  }

  async getRuntimeGitHistory(
    worktreeSelector: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getHistory(target.worktree.path, options)
  }

  async getRuntimeGitConflictOperation(worktreeSelector: string): Promise<GitConflictOperation> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).detectConflictOperation(target.worktree.path)
  }

  async checkoutRuntimeGitBranch(
    worktreeSelector: string,
    branch: string
  ): Promise<RuntimeGitCheckoutResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    await requireRuntimeGitProvider(target).checkoutBranch(target.worktree.path, branch)
    return { ok: true, branch }
  }

  async listRuntimeGitLocalBranches(worktreeSelector: string): Promise<RuntimeGitLocalBranches> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).listLocalBranches(target.worktree.path)
  }
}
