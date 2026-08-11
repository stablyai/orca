import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'

/** Project-level list of gitignored paths to copy into each new worktree.
 *  Cross-tool convention (see issue #7549). */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude'

// Why: a fresh worktree misses gitignored files (.env, .vscode/, config
// secrets); a repo-root .worktreeinclude names the ones to carry over.

// Why: this is the "safe for now" subset — literal files and directories only.
// Glob (`*`/`?`) and negation (`!`) lines are skipped with a warning rather than
// silently mishandled; they can be added later without changing this contract.
const WORKTREE_INCLUDE_MAX_FILE_BYTES = 256 * 1024
// Why: bound the work a single repo file can request; entries beyond this are ignored.
const WORKTREE_INCLUDE_MAX_ENTRIES = 1000

/** Parse `.worktreeinclude` into deduped, repo-root-relative literal paths.
 *  Blank lines and `#` comments are skipped; `\` is normalized to `/`, a `./`
 *  prefix and trailing `/` are stripped. Each entry is anchored to the repo
 *  root (no implicit match-at-any-depth). */
export function parseWorktreeIncludeFile(content: string): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const normalized = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    entries.push(normalized)
  }
  return entries
}

function isUnsupportedPattern(entry: string): boolean {
  return entry.startsWith('!') || entry.includes('*') || entry.includes('?')
}

function isSafeIncludePath(relativePath: string): boolean {
  if (!relativePath || isAbsolute(relativePath)) {
    return false
  }
  const segments = relativePath.split('/')
  return !segments.includes('..') && !segments.includes('') && segments[0] !== '.git'
}

async function readWorktreeIncludeFile(repoPath: string): Promise<string | null> {
  const includePath = join(repoPath, WORKTREE_INCLUDE_FILE)
  try {
    const stats = await lstat(includePath)
    if (!stats.isFile() || stats.size > WORKTREE_INCLUDE_MAX_FILE_BYTES) {
      return null
    }
    return await readFile(includePath, 'utf8')
  } catch {
    return null
  }
}

/** Resolve `.worktreeinclude` at the repo root to concrete repo-relative paths
 *  to copy into a new worktree.
 *
 *  Only paths that exist in the primary checkout **and** are gitignored are
 *  returned — tracked files are already present in a fresh worktree, and
 *  copying untracked-but-unignored files would create spurious diffs.
 *
 *  Never throws: any read/parse/git failure resolves to `[]` so worktree
 *  creation is never blocked by this file. */
export async function resolveWorktreeIncludePaths(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  try {
    const content = await readWorktreeIncludeFile(repoPath)
    if (content === null) {
      return []
    }

    const candidates: string[] = []
    for (const entry of parseWorktreeIncludeFile(content)) {
      if (candidates.length >= WORKTREE_INCLUDE_MAX_ENTRIES) {
        console.warn(
          `[worktree-include] ${WORKTREE_INCLUDE_FILE} lists more than ${WORKTREE_INCLUDE_MAX_ENTRIES} entries; ignoring the rest`
        )
        break
      }
      if (isUnsupportedPattern(entry)) {
        // Glob and negation are not supported yet; skip loudly so the entry isn't silently mis-copied.
        console.warn(
          `[worktree-include] Skipping unsupported ${WORKTREE_INCLUDE_FILE} pattern "${entry}" (only literal files and directories are supported)`
        )
        continue
      }
      if (!isSafeIncludePath(entry)) {
        console.warn(`[worktree-include] Skipping unsafe ${WORKTREE_INCLUDE_FILE} path "${entry}"`)
        continue
      }
      candidates.push(entry)
    }
    if (candidates.length === 0) {
      return []
    }

    // Keep only entries present in the primary checkout — a listed but absent
    // path (e.g. node_modules before install) has nothing to copy.
    const existing: string[] = []
    for (const relativePath of candidates) {
      try {
        await lstat(join(repoPath, relativePath))
        existing.push(relativePath)
      } catch {
        // Absent in the primary checkout — nothing to copy.
      }
    }
    if (existing.length === 0) {
      return []
    }

    // Why: enforce the gitignored-only contract (issue #7549) — never duplicate
    // tracked files or surface unignored ones as spurious worktree diffs.
    const ignored = new Set(await checkIgnoredPaths(repoPath, existing, options))
    return existing.filter((relativePath) => ignored.has(relativePath)).sort()
  } catch (error) {
    console.warn(`[worktree-include] Failed to resolve ${WORKTREE_INCLUDE_FILE} paths:`, error)
    return []
  }
}
