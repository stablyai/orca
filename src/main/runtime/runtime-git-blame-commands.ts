import type { GitLineBlameResult } from '../../shared/git-line-blame-types'
import { getFileBlame, getLineBlame } from '../git/line-blame'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  requireRuntimeGitProvider,
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
    // `null` means the host is local; an unreachable SSH host throws rather than
    // silently running remote work here.
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
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
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
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
