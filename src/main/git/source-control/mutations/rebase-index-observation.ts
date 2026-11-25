import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath
} from '../../../../shared/git/metadata/git-metadata-path'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../../command-runner/git-runtime-options'

/** The index bytes identify staged content, including changes to an already-staged path. */
export async function readRebaseIndexObservation(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--git-path', 'index'],
      gitOptionsForWorktree(worktreePath, options)
    )
    const rawPath = stdout.replace(/\r?\n$/, '')
    if (!rawPath || /[\r\n]/.test(rawPath)) {
      return null
    }
    const hostWorktree = resolveWorktreeHostPath(worktreePath, options)
    if (!hostWorktree) {
      return null
    }
    const indexPath = resolveGitMetadataPath(hostWorktree, rawPath, options)
    if (!indexPath) {
      return null
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(indexPath)) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
