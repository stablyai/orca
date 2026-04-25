/**
 * Plain readdir-based file listing fallback.
 *
 * Why: when neither ripgrep nor git is available (e.g. a non-git folder on a
 * remote machine without rg), we still need to list files for quick-open.
 * This walks the directory tree using Node's fs.readdir, respecting the same
 * blocklist and timeout constraints as the git-based fallback.
 */
import { readdir } from 'fs/promises'
import { join, relative } from 'path'

const MAX_FILES = 10_000
const TIMEOUT_MS = 10_000

// Why: mirrors the HIDDEN_DIR_BLOCKLIST in fs-handler-git-fallback.ts —
// tool-generated dirs that clutter quick-open. User-authored dotdirs like
// .github/ and .devcontainer/ are intentionally kept discoverable.
const HIDDEN_DIR_BLOCKLIST = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.stably',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky'
])

function shouldDescend(name: string): boolean {
  if (name === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(name)) {
    return false
  }
  return true
}

/**
 * Recursively list files under `rootPath` using fs.readdir.
 * Returns relative POSIX paths, capped at MAX_FILES with a timeout.
 */
export async function listFilesWithReaddir(rootPath: string): Promise<string[]> {
  const files: string[] = []
  const deadline = Date.now() + TIMEOUT_MS

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES || Date.now() > deadline) {
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Permission denied, symlink loop, etc. — skip silently.
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES || Date.now() > deadline) {
        return
      }

      const name = entry.name
      if (entry.isDirectory()) {
        if (shouldDescend(name)) {
          await walk(join(dir, name))
        }
      } else if (entry.isFile()) {
        // Why: path.relative() returns backslashes on Windows. The quick-open
        // UI assumes POSIX separators for display and fuzzy matching.
        const relPath = relative(rootPath, join(dir, name)).replace(/\\/g, '/')
        files.push(relPath)
      }
    }
  }

  await walk(rootPath)
  return files
}
