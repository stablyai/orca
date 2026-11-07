import type { GitRuntimeOptions } from '../../../git/git-runtime-options'
import { resolveInitializedSubmodulePath } from '../../../git/source-control/submodule-repos'

/** The folder a remote git action runs in: the registered worktree, or one of its submodules. */
export async function resolveGitActionPath(
  args: { submodulePath?: string; pushTarget?: unknown },
  registeredWorktreePath: string,
  gitOptions: GitRuntimeOptions
): Promise<string> {
  if (args.submodulePath === undefined) {
    return registeredWorktreePath
  }
  // The parent's fork push target names the parent's branch, not the submodule's.
  if (args.pushTarget) {
    throw new Error('A submodule action cannot use the worktree push target')
  }
  return resolveInitializedSubmodulePath(registeredWorktreePath, args.submodulePath, gitOptions)
}
