// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithConstructor } from './runtime-file-commands-constructor'
import type { RuntimeFileReadResult } from '../../shared/runtime-types'
import { isMobileBinaryPath, isSafeMobileRelativePath } from './runtime-file-command-host'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { readLocalMobileFile } from './runtime-file-commands-terminal-file-paths'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import { requireRuntimeFileProvider } from './runtime-file-command-target'

export class RuntimeFileCommandsWithReadMobileFile extends RuntimeFileCommandsWithConstructor {
  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const provider = requireRuntimeFileProvider(target)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = provider
      ? await this.readRemoteMobileFile(filePath, provider)
      : await readLocalMobileFile(filePath, store)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: worktree.id,
      relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }
}
