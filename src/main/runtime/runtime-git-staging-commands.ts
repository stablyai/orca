import {
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  discardChanges,
  stageFile,
  stageWorktreeChanges,
  unstageFile
} from '../git/status'
import type {
  GitStageWorktreeScope,
  GitStageWorktreeScopeReceipt
} from '../../shared/git-stage-worktree-scope'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitStagingCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async stageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.stageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await stageFile(target.worktree.path, relativePath, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async unstageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.unstageFile(target.worktree.path, relativePath)
      return { ok: true }
    }
    await unstageFile(target.worktree.path, relativePath, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async bulkStageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[],
    scope?: GitStageWorktreeScope
  ): Promise<{ ok: true } & Partial<GitStageWorktreeScopeReceipt>> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      // Why: the provider throws when its host did not run the scoped stage, so success is a receipt.
      await provider.bulkStageFiles(target.worktree.path, relativePaths, scope)
      return scope ? { ok: true, stagedScope: scope } : { ok: true }
    }
    if (scope) {
      const receipt = await stageWorktreeChanges(target.worktree.path, scope, {
        ...localGitOptionsForTarget(target),
        admissionTier: 'interactive',
        sharedLinkPaths: target.repo ? getWorktreeSharedLinkPaths(target.repo) : []
      })
      return { ok: true, ...receipt }
    }
    await bulkStageFiles(target.worktree.path, relativePaths, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async bulkUnstageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.bulkUnstageFiles(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkUnstageFiles(target.worktree.path, relativePaths, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async bulkDiscardRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.bulkDiscardChanges(target.worktree.path, relativePaths)
      return { ok: true }
    }
    await bulkDiscardChanges(target.worktree.path, relativePaths, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async discardRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.discardChanges(target.worktree.path, relativePath)
      return { ok: true }
    }
    await discardChanges(target.worktree.path, relativePath, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }
}
