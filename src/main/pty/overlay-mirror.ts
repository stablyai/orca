// Why: Pi (PI_CODING_AGENT_DIR) and OpenCode (OPENCODE_CONFIG_DIR) both inject
// Orca-owned files into overlay directories that mirror a user-owned
// source dir via symlinks/junctions. The safety guarantees here -- never
// descend into a symlink/junction during teardown, refuse to operate outside
// the overlay root, lstat-not-stat to avoid following links -- are the result
// of debugging issue #1083 (Windows directory junctions causing fs.rmSync to
// delete the user's real Pi state). Shared in one module so a new overlay
// consumer cannot accidentally diverge from the audited cleanup behavior.

import {
  cpSync,
  linkSync,
  lstatSync,
  opendirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const OVERLAY_REMOVE_MAX_ENTRIES = 100_000
export const OVERLAY_REMOVE_MAX_DEPTH = 256

type OverlayRemoveLimits = {
  maxEntries: number
  maxDepth: number
}

type OverlayRemoveState = {
  entries: number
  exhausted: boolean
  limits: OverlayRemoveLimits
}

export function mirrorEntry(sourcePath: string, targetPath: string): void {
  // Why: lstatSync (not statSync) so that if the user's source dir contains
  // its OWN symlinks (e.g. skills symlinked from ~/.agents/skills), we mirror
  // the link itself rather than resolving it to a type and then creating a
  // junction at an unrelated path. isSymbolicLink() MUST be checked before
  // isDirectory() on Windows because directory junctions/reparse points
  // report both true.
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

export function mirrorWritableFileEntry(sourcePath: string, targetPath: string): void {
  if (process.platform === 'win32') {
    try {
      linkSync(sourcePath, targetPath)
      return
    } catch {
      // Cross-device homes cannot hardlink; try a file symlink so writable
      // SQLite state can still flow to source instead of a disposable copy.
    }

    try {
      symlinkSync(sourcePath, targetPath, 'file')
      return
    } catch {
      throw new Error(`Unable to create source-backed writable file mirror: ${targetPath}`)
    }
  }

  symlinkSync(sourcePath, targetPath, 'file')
}

// Exported for tests. A "descend candidate" is an entry whose children we
// should recurse into when tearing down the overlay. Anything that is a
// symlink (including a Windows directory junction) must NOT be a candidate
// even if it also reports isDirectory() -- following it would walk into the
// link target and delete user data, which is the bug in #1083.
export function isSafeDescendCandidate(stats: {
  isSymbolicLink(): boolean
  isDirectory(): boolean
}): boolean {
  if (stats.isSymbolicLink()) {
    return false
  }
  return stats.isDirectory()
}

function resolveRemoveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

function closeDirectory(directory: ReturnType<typeof opendirSync>): boolean {
  try {
    directory.closeSync()
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ERR_DIR_CLOSED'
  }
}

function removeTreeWithinLimits(path: string, depth: number, state: OverlayRemoveState): boolean {
  if (state.exhausted) {
    return false
  }

  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }

  // On Windows, lstat on a directory junction can report BOTH
  // isSymbolicLink() === true AND isDirectory() === true, so we MUST check
  // isSymbolicLink first -- otherwise a junction enters the recursive branch
  // and enumerates the link's target, the exact bug in #1083.
  if (!isSafeDescendCandidate(stat)) {
    try {
      unlinkSync(path)
      return true
    } catch {
      // Best-effort: antivirus/indexers can hold handles briefly on Windows.
      // A leftover link is harmless; the next spawn rebuilds the overlay.
      return false
    }
  }

  let directory
  try {
    directory = opendirSync(path, { bufferSize: 32 })
  } catch {
    return false
  }

  let completed = true
  try {
    while (!state.exhausted) {
      const entry = directory.readSync()
      if (entry === null) {
        break
      }
      if (state.entries >= state.limits.maxEntries) {
        state.exhausted = true
        completed = false
        break
      }
      state.entries += 1

      const child = join(path, entry.name)
      if (isSafeDescendCandidate(entry)) {
        if (depth >= state.limits.maxDepth) {
          state.exhausted = true
          completed = false
          break
        }
        completed = removeTreeWithinLimits(child, depth + 1, state) && completed
        continue
      }
      try {
        unlinkSync(child)
      } catch {
        completed = false
      }
    }
  } catch {
    completed = false
  } finally {
    completed = closeDirectory(directory) && completed
  }

  try {
    rmdirSync(path)
    return completed
  } catch {
    // Directory may be non-empty if an unlink above failed; harmless.
    return false
  }
}

// Why: the overlay tree contains symlinks/junctions that point back into the
// user's real state dir. Stream a bounded traversal and never descend into a
// link; a pathological tree is left for a later cleanup instead of growing
// an unbounded directory array or call stack in Electron's main process.
export function safeRemoveTree(path: string, requested?: Partial<OverlayRemoveLimits>): boolean {
  const state: OverlayRemoveState = {
    entries: 0,
    exhausted: false,
    limits: {
      maxEntries: resolveRemoveLimit(
        requested?.maxEntries,
        OVERLAY_REMOVE_MAX_ENTRIES,
        'maxEntries'
      ),
      maxDepth: resolveRemoveLimit(requested?.maxDepth, OVERLAY_REMOVE_MAX_DEPTH, 'maxDepth')
    }
  }
  return removeTreeWithinLimits(path, 0, state)
}

// Why: last-line guard against an overlay-root constant ever being
// mis-resolved. Any caller that points safeRemoveTree at a path outside its
// designated overlay root is refused so a misconfiguration cannot turn into
// an `rm -rf` of arbitrary user data. Logs (rather than throws) so a buggy
// caller stays visible without crashing the PTY spawn.
export function safeRemoveOverlay(overlayDir: string, overlayRoot: string): boolean {
  const resolvedRoot = resolve(overlayRoot)
  const resolvedTarget = resolve(overlayDir)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    console.warn(
      `[overlay-mirror] refusing to remove overlay outside root: target=${resolvedTarget} root=${resolvedRoot}`
    )
    return false
  }
  return safeRemoveTree(resolvedTarget)
}
