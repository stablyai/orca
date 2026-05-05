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
import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { HIDDEN_DIR_BLOCKLIST, shouldExcludeQuickOpenRelPath } from '../shared/quick-open-filter'

const MAX_FILES = 10_000
const TIMEOUT_MS = 10_000

function shouldDescend(name: string): boolean {
  if (name === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(name)) {
    return false
  }
  return true
}

/**
 * Recursively list files under `rootPath` using fs.readdir.
 * Returns relative POSIX paths. Rejects on cap/deadline so the UI cannot
 * mistake a partial list for a complete empty result.
 */
export async function listFilesWithReaddir(
  rootPath: string,
  excludePathPrefixes: readonly string[] = []
): Promise<string[]> {
  const files: string[] = []
  const deadline = Date.now() + TIMEOUT_MS
  let hitLimit = false

  async function walk(dir: string): Promise<void> {
    if (hitLimit) {
      return
    }
    if (files.length >= MAX_FILES || Date.now() > deadline) {
      hitLimit = true
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Why: permission denied / symlink loop on an individual subtree is
      // expected on home-dir roots (e.g. root-owned mounts). Skip the
      // subtree silently — this does NOT promote to a full-listing failure.
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES || Date.now() > deadline) {
        hitLimit = true
        return
      }

      const name = entry.name
      const absPath = join(dir, name)
      // Why: path.relative returns backslashes on Windows. Quick-open UI
      // assumes POSIX separators for display and fuzzy matching.
      const relPath = relative(rootPath, absPath).replace(/\\/g, '/')
      if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
        continue
      }
      if (entry.isDirectory()) {
        if (shouldDescend(name)) {
          await walk(absPath)
        }
      } else if (entry.isFile()) {
        files.push(relPath)
      }
    }
  }

  await walk(rootPath)
  if (hitLimit) {
    throw new Error(
      files.length >= MAX_FILES
        ? `File listing exceeded ${MAX_FILES} files`
        : 'File listing timed out'
    )
  }
  return files
}
