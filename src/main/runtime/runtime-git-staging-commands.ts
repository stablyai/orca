import {
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  discardChanges,
  stageFile,
  unstageFile
} from '../git/status'
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
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.bulkStageFiles(target.worktree.path, relativePaths)
      return { ok: true }
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
