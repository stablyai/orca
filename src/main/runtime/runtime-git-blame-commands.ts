import type { GitLineBlameResult } from '../../shared/git-line-blame-types'
import { getFileBlame, getLineBlame } from '../git/line-blame'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitBlameCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  /**
   * Authorship for every line of a file, in one walk.
   *
   * Why whole-file: `-L` does not make blame cheaper — git walks the same history
   * either way — so one walk answers every line for the price of a single-line read.
   */
  async getRuntimeGitFileBlame(
    worktreeSelector: string,
    filePath: string
  ): Promise<Record<number, GitLineBlameResult> | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    if (target.connectionId) {
      const provider = getSshGitProvider(target.connectionId)
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getFileBlame(target.worktree.path, relativePath)
    }
    return getFileBlame(target.worktree.path, relativePath, localGitOptionsForTarget(target))
  }

  /** Authorship for one 1-indexed line; the fallback when a whole-file read is unavailable. */
  async getRuntimeGitLineBlame(
    worktreeSelector: string,
    filePath: string,
    line1Indexed: number
  ): Promise<GitLineBlameResult | null> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    if (target.connectionId) {
      const provider = getSshGitProvider(target.connectionId)
      if (!provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.getLineBlame(target.worktree.path, relativePath, line1Indexed)
    }
    return getLineBlame(
      target.worktree.path,
      relativePath,
      line1Indexed,
      localGitOptionsForTarget(target)
    )
  }
}
