import type { GitStatusEntry } from '../../../shared/git-status-types'
import { isWorktreeUndiscardableGitlink } from '../../../shared/source-control-discard-all-sequence'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'

/** Plain `git restore` recurses into submodules when submodule.recurse is on, so those gitlinks stay discardable. */
export async function markRecursiveSubmoduleRestores(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<GitStatusEntry[]> {
  if (!entries.some(isWorktreeUndiscardableGitlink)) {
    return entries
  }
  if (!(await readSubmoduleRecurse(worktreePath, options))) {
    return entries
  }
  return entries.map((entry) =>
    entry.submodule ? { ...entry, submodule: { ...entry.submodule, restoreRecurses: true } } : entry
  )
}

async function readSubmoduleRecurse(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--bool', '--get', 'submodule.recurse'],
      gitReadOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() === 'true'
  } catch {
    // Unset (exit 1) or invalid config: restore will not recurse, so keep discard hidden.
    return false
  }
}
