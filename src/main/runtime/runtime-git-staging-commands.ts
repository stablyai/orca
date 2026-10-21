import type {
  GitStageWorktreeScope,
  GitStageWorktreeScopeReceipt
} from '../../shared/git-stage-worktree-scope'
import {
  normalizeRuntimeGitRelativePath,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitStagingCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async stageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    await requireRuntimeGitProvider(target).stageFile(target.worktree.path, relativePath)
    return { ok: true }
  }

  async unstageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    await requireRuntimeGitProvider(target).unstageFile(target.worktree.path, relativePath)
    return { ok: true }
  }

  async bulkStageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[],
    scope?: GitStageWorktreeScope
  ): Promise<{ ok: true } & Partial<GitStageWorktreeScopeReceipt>> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    // Why: every provider throws when its host did not run the scoped stage, so success is a receipt.
    await requireRuntimeGitProvider(target).bulkStageFiles(
      target.worktree.path,
      relativePaths,
      scope
    )
    return scope ? { ok: true, stagedScope: scope } : { ok: true }
  }

  async bulkUnstageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    await requireRuntimeGitProvider(target).bulkUnstageFiles(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async bulkDiscardRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    await requireRuntimeGitProvider(target).bulkDiscardChanges(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async discardRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    await requireRuntimeGitProvider(target).discardChanges(target.worktree.path, relativePath)
    return { ok: true }
  }
}
