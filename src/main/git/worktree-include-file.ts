import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

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

/** Copy only existing, gitignored paths; failures return [] so inclusion cannot block creation. */
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
    const existing = existence.filter(
      (relativePath): relativePath is string => relativePath !== null
    )
    if (existing.length === 0) {
      return []
    }

    // Copying unignored paths would introduce spurious worktree diffs.
    const ignored = new Set(await checkIgnoredPaths(repoPath, existing, options))
    return existing.filter((relativePath) => ignored.has(relativePath)).sort()
  } catch (error) {
    console.warn(`[worktree-include] Failed to resolve ${WORKTREE_INCLUDE_FILE} paths:`, error)
    return []
  }
}
