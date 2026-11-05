import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { detectConflictOperation } from './git-conflict-operation'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

export function commitChanges(
  worktreePath: string,
  message: string,
  options: GitRuntimeOptions = {}
): Promise<{ success: boolean; error?: string }> {
  return runCommit(worktreePath, ['commit', '-m', message], options)
}

/** Concludes a paused merge with Git's MERGE_MSG; strip drops its "# Conflicts:" comments like an editor commit would. */
export async function completeMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<{ success: boolean; error?: string }> {
  // Without MERGE_HEAD, --no-edit would commit staged changes under commit.template text.
  if ((await detectConflictOperation(worktreePath, options)) !== 'merge') {
    return { success: false, error: 'There is no merge in progress.' }
  }
  return runCommit(worktreePath, ['commit', '--no-edit', '--cleanup=strip'], options)
}

async function runCommit(
  worktreePath: string,
  args: string[],
  options: GitRuntimeOptions
): Promise<{ success: boolean; error?: string }> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    return { success: true }
  } catch (error) {
    // Hook/GPG failures use stderr; nothing-to-commit output can be on stdout.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  } finally {
    invalidateGitReadCaches()
  }
}
