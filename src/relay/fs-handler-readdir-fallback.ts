/**
 * Plain readdir-based file listing fallback.
 *
 * Why: when neither ripgrep nor git is available (e.g. a non-git folder on a
 * remote machine without rg), we still need to list files for quick-open.
 * This walks the directory tree using Node's fs.readdir, applying the shared
 * Quick Open filter policy (blocklist + nested-worktree excludes).
 *
 * Partial results: the cap and deadline remain as containment, but a capped
 * or timed-out traversal now rejects instead of returning a partial list —
 * otherwise Quick Open would display "No matching files" for what was
 * actually an incomplete scan.
 */
import {
  createQuickOpenReaddirBudget,
  listQuickOpenFilesWithReaddir
} from '../shared/quick-open-readdir-walk'

/**
 * Recursively list files under `rootPath` using fs.readdir.
 * Returns relative POSIX paths. Rejects on cap/deadline so the UI cannot
 * mistake a partial list for a complete empty result.
 */
export async function listFilesWithReaddir(
  rootPath: string,
  excludePathPrefixes: readonly string[] = []
): Promise<string[]> {
  return listQuickOpenFilesWithReaddir(rootPath, {
    excludePathPrefixes,
    budget: createQuickOpenReaddirBudget()
  })
}
