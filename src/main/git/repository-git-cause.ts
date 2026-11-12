import { parseWslUncPath } from '../../shared/wsl-paths'
import { hasActiveTraceSink } from '../observability/tracer'
import { runWithGitCause, type GitOperationCause } from '../observability/git-operation-cause'
import { peekGitCommonDir } from './canonical-repo-key'

/** Diagnostics only reuse identity already resolved by a repository owner. */
export function withRepositoryGitCause<T>(
  repoPath: string,
  options: { wslDistro?: string },
  cause: GitOperationCause,
  run: () => Promise<T>
): Promise<T> {
  if (!hasActiveTraceSink()) {
    return run()
  }
  const commonDir = peekGitCommonDir(repoPath, options)
  const distro = process.platform === 'win32' ? parseWslUncPath(repoPath)?.distro : undefined
  const namespace = process.platform !== 'win32' ? 'local' : distro ? `wsl:${distro}` : undefined
  return runWithGitCause(cause, commonDir && namespace ? { namespace, commonDir } : undefined, run)
}
