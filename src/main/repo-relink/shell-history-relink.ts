import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getHistoryRoot, listWslHistoryRoots } from '../terminal-history-paths'
import { hashWorktreeId } from '../terminal-history-id'

const SHELL_HISTORY_FILES = ['zsh_history', 'bash_history'] as const

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Shell history is filed under a hash of the worktree id, so a relinked worktree would start empty.
 * Copy, not move: shells still open in the old worktree keep appending to their HISTFILE, and the
 * history GC retires the old directory once its id is gone.
 */
export async function copyShellHistoryForRenamedWorktree(
  oldWorktreeId: string,
  newWorktreeId: string,
  roots: readonly string[] = [getHistoryRoot(), ...listWslHistoryRoots()]
): Promise<number> {
  let copied = 0
  for (const root of roots) {
    const source = join(root, hashWorktreeId(oldWorktreeId))
    const destination = join(root, hashWorktreeId(newWorktreeId))
    if (!(await exists(source)) || (await exists(destination))) {
      continue
    }
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      for (const name of SHELL_HISTORY_FILES) {
        if (await exists(join(source, name))) {
          await copyFile(join(source, name), join(destination, name))
        }
      }
      await writeFile(
        join(destination, 'meta.json'),
        JSON.stringify({ worktreeId: newWorktreeId, createdAt: new Date().toISOString() }),
        { mode: 0o600 }
      )
      copied++
    } catch (error) {
      console.warn(
        `[repo-relink] Could not copy shell history: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return copied
}
