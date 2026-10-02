import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../shared/cross-platform-path'

export type FormatTarget = {
  absolutePath: string
  relativePath: string
}

export function getWorktreeRelativePath(
  worktreePath: string,
  absoluteFilePath: string
): string | null {
  // Why: node's `path.relative` resolves against the host platform, so a WSL UNC
  // worktree only parses correctly on Windows. This comparison is platform-free,
  // which also lets CI cover the WSL branch.
  const relativePath = relativePathInsideRoot(worktreePath, absoluteFilePath)
  if (!relativePath) {
    return null
  }

  return normalizeRuntimePathSeparators(relativePath)
}

/**
 * Resolves the saved file against its worktree, or null when it is not inside.
 * The caller-supplied path is untrusted: `..` segments and symlinks must not
 * point the formatter, which can write, at a file outside the worktree.
 */
export async function resolveFormatTarget({
  worktreePath,
  absoluteFilePath,
  isRemote
}: {
  worktreePath: string
  absoluteFilePath: string
  /** The path lives on another host, so this machine's filesystem cannot canonicalize it. */
  isRemote: boolean
}): Promise<FormatTarget | null> {
  if (hasParentSegment(absoluteFilePath)) {
    return null
  }

  let root = worktreePath
  let file = absoluteFilePath
  if (!isRemote) {
    try {
      root = await canonicalizeExistingPrefix(worktreePath)
      file = await canonicalizeExistingPrefix(absoluteFilePath)
    } catch {
      // Why: a path that cannot be inspected cannot be shown to be inside the worktree.
      return null
    }
  }

  const relativePath = getWorktreeRelativePath(root, file)
  return relativePath === null ? null : { absolutePath: file, relativePath }
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..')
}

// Why: the saved file normally exists, but canonicalizing only what exists lets
// the check also cover a path a test or a racing delete leaves missing.
async function canonicalizeExistingPrefix(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    return path
  }
  const missingSegments: string[] = []
  let existing = path
  for (;;) {
    try {
      const real = await realpath(existing)
      if (missingSegments.length === 0) {
        return real
      }
      // Why: nothing on the path exists, so there is no symlink to follow; keep the caller's spelling instead of a root-relative guess.
      return dirname(existing) === existing ? path : join(real, ...missingSegments)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
      const parent = dirname(existing)
      if (parent === existing) {
        return path
      }
      missingSegments.unshift(basename(existing))
      existing = parent
    }
  }
}
