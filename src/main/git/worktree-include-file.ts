import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type {
  WorktreeConfiguredPathResolveResult,
  WorktreeConfiguredPathSkip
} from './worktree-configured-path-skips'

/** Cross-tool convention for copying selected gitignored paths into new worktrees (#7549). */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude'

const WORKTREE_INCLUDE_MAX_FILE_BYTES = 256 * 1024
const WORKTREE_INCLUDE_MAX_ENTRIES = 1000
// Bound stat fan-out without serializing independent paths.
const WORKTREE_INCLUDE_PATH_STAT_CONCURRENCY = 8

/** Entries are literal paths anchored to the repo root, without implicit depth matching. */
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
 *  copied — tracked files are already present in a fresh worktree, and
 *  copying untracked-but-unignored files would create spurious diffs. Skipped
 *  entries are returned so create can warn instead of reporting a silent success.
 *
 *  Never throws: any read/parse/git failure resolves to empty paths so worktree
 *  creation is never blocked by this file. */
export async function resolveWorktreeIncludePaths(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<WorktreeConfiguredPathResolveResult> {
  const skipped: WorktreeConfiguredPathSkip[] = []
  try {
    const content = await readWorktreeIncludeFile(repoPath)
    if (content === null) {
      return { paths: [], skipped }
    }

    const candidates: string[] = []
    let loggedEntryLimit = false
    for (const entry of parseWorktreeIncludeFile(content)) {
      if (candidates.length >= WORKTREE_INCLUDE_MAX_ENTRIES) {
        // Why: every excess parsed entry is refused, not just the first over the cap.
        if (!loggedEntryLimit) {
          console.warn(
            `[worktree-include] ${WORKTREE_INCLUDE_FILE} lists more than ${WORKTREE_INCLUDE_MAX_ENTRIES} entries; ignoring the rest`
          )
          loggedEntryLimit = true
        }
        skipped.push({ mechanism: 'include', path: entry, reason: 'too-many-entries' })
        continue
      }
      if (isUnsupportedPattern(entry)) {
        console.warn(
          `[worktree-include] Skipping unsupported ${WORKTREE_INCLUDE_FILE} pattern "${entry}" (only literal files and directories are supported)`
        )
        skipped.push({ mechanism: 'include', path: entry, reason: 'unsupported-pattern' })
        continue
      }
      if (!isSafeIncludePath(entry)) {
        console.warn(`[worktree-include] Skipping unsafe ${WORKTREE_INCLUDE_FILE} path "${entry}"`)
        skipped.push({ mechanism: 'include', path: entry, reason: 'unsafe' })
        continue
      }
      candidates.push(entry)
    }
    if (candidates.length === 0) {
      return { paths: [], skipped }
    }

    const existence = await mapWithConcurrency(
      candidates,
      WORKTREE_INCLUDE_PATH_STAT_CONCURRENCY,
      async (relativePath) => {
        try {
          await lstat(join(repoPath, relativePath))
          return relativePath
        } catch {
          return null
        }
      }
    )
    const existing: string[] = []
    for (const [index, relativePath] of candidates.entries()) {
      if (existence[index] === null) {
        skipped.push({ mechanism: 'include', path: relativePath, reason: 'missing' })
        continue
      }
      existing.push(relativePath)
    }
    if (existing.length === 0) {
      return { paths: [], skipped }
    }

    // Copying unignored paths would introduce spurious worktree diffs.
    const ignored = new Set(await checkIgnoredPaths(repoPath, existing, options))
    const paths: string[] = []
    for (const relativePath of existing) {
      if (!ignored.has(relativePath)) {
        console.warn(
          `[worktree-include] Skipping "${relativePath}": only gitignored paths can be copied`
        )
        skipped.push({ mechanism: 'include', path: relativePath, reason: 'not-gitignored' })
        continue
      }
      paths.push(relativePath)
    }
    return { paths: paths.sort(), skipped }
  } catch (error) {
    console.warn(`[worktree-include] Failed to resolve ${WORKTREE_INCLUDE_FILE} paths:`, error)
    return { paths: [], skipped }
  }
}
