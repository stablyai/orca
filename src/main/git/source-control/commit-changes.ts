import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

export async function commitChanges(
  worktreePath: string,
  message: string,
  options: GitRuntimeOptions & { amend?: boolean } = {}
): Promise<{ success: boolean; error?: string }> {
  invalidateGitReadCaches()
  try {
    // Amend with an empty message must keep the previous commit's message, not fail like a new commit.
    const args = options.amend
      ? message.trim().length > 0
        ? ['commit', '--amend', '-m', message]
        : ['commit', '--amend', '--no-edit']
      : ['commit', '-m', message]
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
