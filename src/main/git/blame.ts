import { basename, dirname, isAbsolute, join } from 'node:path'
import type { GitBlameResult } from '../../shared/git-blame'
import { parseBlameOutput } from '../../shared/git-blame-parser'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

const GIT_BLAME_TIMEOUT_MS = 30_000

/**
 * Runs git blame from the file's own directory so nested repositories resolve.
 */
export async function getBlame(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlameResult> {
  // Why: folder workspaces can point worktreePath at a non-git parent dir with
  // the real repo nested inside. Running blame from the file's own directory
  // with a bare filename lets git resolve the enclosing repo at any depth, and
  // avoids re-basing paths (which breaks under symlinked worktree roots).
  const absFilePath = isAbsolute(filePath) ? filePath : join(worktreePath, filePath)
  const { stdout } = await gitExecFileAsync(['blame', '--porcelain', '--', basename(absFilePath)], {
    ...gitOptionsForWorktree(dirname(absFilePath), options),
    timeout: GIT_BLAME_TIMEOUT_MS
  })
  return parseBlameOutput(stdout)
}
