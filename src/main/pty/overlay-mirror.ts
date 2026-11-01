// Pi/OpenCode overlays link into user-owned state; teardown must never follow symlinks/junctions or leave the owned root (#1083).

import {
  cpSync,
  linkSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function mirrorEntry(sourcePath: string, targetPath: string): void {
  // Mirror user symlinks themselves; Windows junctions can also report isDirectory(), so test isSymbolicLink() first.
  const sourceStats = lstatSync(sourcePath)
  const isSymlink = sourceStats.isSymbolicLink()
  const isDirectoryLike = !isSymlink && sourceStats.isDirectory()

  if (process.platform === 'win32') {
    if (isDirectoryLike) {
      symlinkSync(sourcePath, targetPath, 'junction')
      return
    }

    try {
      linkSync(sourcePath, targetPath)
      return
    } catch {
      cpSync(sourcePath, targetPath)
      return
    }
  }

  symlinkSync(sourcePath, targetPath, isDirectoryLike ? 'dir' : 'file')
}

// A junction may report both flags; descending into it would delete the linked user directory (#1083).
export function isSafeDescendCandidate(stats: {
  isSymbolicLink(): boolean
  isDirectory(): boolean
}): boolean {
  if (stats.isSymbolicLink()) {
    return false
  }
  return stats.isDirectory()
}

// fs.rmSync recursion has followed Windows junctions into user state; unlink links and recurse only into real directories.
export function safeRemoveTree(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }

  if (!isSafeDescendCandidate(stat)) {
    try {
      unlinkSync(path)
    } catch {
      // Windows indexers/antivirus may hold links; leftovers are safe and rebuilt on next spawn.
    }
    return
  }

  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const child = join(path, entry.name)
    if (isSafeDescendCandidate(entry)) {
      safeRemoveTree(child)
      continue
    }
    try {
      unlinkSync(child)
    } catch {}
  }

  try {
    rmdirSync(path)
  } catch {
    // Failed child unlinks may leave a harmless nonempty directory.
  }
}

// Reject symlink parents inside the owned overlay.
function hasSafeOverlayAncestors(root: string, relativeTarget: string): boolean {
  let current = root
  try {
    if (lstatSync(current).isSymbolicLink()) {
      return false
    }
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  }
  const segments = relativeTarget.split(sep).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    if (index === segments.length - 1) {
      break
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return false
      }
    } catch (error) {
      return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
    }
  }
  return true
}

// Refuse paths outside the owned root; log misconfiguration without crashing PTY spawn.
export function safeRemoveOverlay(overlayDir: string, overlayRoot: string): void {
  const resolvedRoot = resolve(overlayRoot)
  const resolvedTarget = resolve(overlayDir)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !hasSafeOverlayAncestors(resolvedRoot, rel)
  ) {
    console.warn(
      `[overlay-mirror] refusing to remove overlay outside root: target=${resolvedTarget} root=${resolvedRoot}`
    )
    return
  }
  safeRemoveTree(resolvedTarget)
}
