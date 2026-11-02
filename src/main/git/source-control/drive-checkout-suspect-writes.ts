import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { driveCheckoutSuspectsWithin } from './drive-checkout-suspect-status'
import { bulkPathspecCommands } from './git-pathspec'

/** The write a path operation redoes for its suspects; pathspecs are appended after `--`. */
export type DriveCheckoutSuspectWrite =
  | readonly ['add', '--update']
  | readonly ['restore', '--worktree']

/** Index entries at stage 0 among `paths`; unmerged ones are left to the caller's own write. */
async function listMergedTrackedPaths(
  worktreePath: string,
  paths: readonly string[],
  options: GitRuntimeOptions
): Promise<string[]> {
  const tracked = new Set<string>()
  for (const args of bulkPathspecCommands(
    ['ls-files', '-z', '--stage', '--'],
    paths,
    worktreePath,
    options
  )) {
    const { stdout } = await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    for (const record of stdout.split('\0')) {
      const match = /^\d+ [0-9a-f]+ 0\t(.+)$/s.exec(record)
      if (match) {
        tracked.add(match[1])
      }
    }
  }
  return [...tracked]
}

/** Redo suspect writes with default stat: minimal-stat add/restore can silently miss paths status already reports dirty. */
export async function redoWriteForDriveCheckoutSuspects(
  worktreePath: string,
  pathspecs: readonly string[],
  write: DriveCheckoutSuspectWrite,
  options: GitRuntimeOptions
): Promise<void> {
  const suspects = driveCheckoutSuspectsWithin(worktreePath, pathspecs, options)
  if (suspects.length === 0) {
    return
  }
  // Why tracked only: an untracked or ignored suspect fails the pathspec, and minimal stat never misses one.
  const tracked = await listMergedTrackedPaths(worktreePath, suspects, options)
  // Why argv over --pathspec-from-file: `add`/`restore` only gained it in Git 2.26; suspects are capped.
  const commands = bulkPathspecCommands(
    ['-c', 'core.checkStat=default', ...write, '--'],
    tracked,
    worktreePath,
    options
  )
  for (const args of commands) {
    await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
  }
}
