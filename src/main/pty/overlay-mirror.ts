// Why: Pi (PI_CODING_AGENT_DIR) and OpenCode (OPENCODE_CONFIG_DIR) both inject
// Orca-owned files into per-PTY overlay directories that mirror a user-owned
// source dir via symlinks/junctions. The safety guarantees here -- never
// descend into a symlink/junction during teardown, refuse to operate outside
// the overlay root, lstat-not-stat to avoid following links -- are the result
// of debugging issue #1083 (Windows directory junctions causing fs.rmSync to
// delete the user's real Pi state). Shared in one module so a new overlay
// consumer cannot accidentally diverge from the audited cleanup behavior.

import { cpSync, linkSync, lstatSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

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

// Why: the overlay tree contains symlinks/junctions that point back into the
// user's real state dir. fs.rmSync with { recursive: true } has repeatedly
// regressed on Windows when walking NTFS junctions -- it can follow them and
// delete the *target*, destroying the user's data. Never descend into a
// symlink/junction here: for any non-real-directory entry we unlink the link
// itself; only entries that are truly directories on disk are recursed into.
export function safeRemoveTree(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }

  // On Windows, lstat on a directory junction can report BOTH
  // isSymbolicLink() === true AND isDirectory() === true, so we MUST check
  // isSymbolicLink first -- otherwise a junction enters the recursive branch
  // and readdirSync enumerates the link's target, the exact bug in #1083.
  if (!isSafeDescendCandidate(stat)) {
    try {
      unlinkSync(path)
    } catch {
      // Best-effort: antivirus/indexers can hold handles briefly on Windows.
      // A leftover link is harmless; the next spawn rebuilds the overlay.
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
    } catch {
      // Best-effort, see above.
    }
  }

  try {
    rmdirSync(path)
  } catch {
    // Directory may be non-empty if an unlink above failed; harmless.
  }
}

// Why: last-line guard against an overlay-root constant ever being
// mis-resolved. Any caller that points safeRemoveTree at a path outside its
// designated overlay root is refused so a misconfiguration cannot turn into
// an `rm -rf` of arbitrary user data. Logs (rather than throws) so a buggy
// caller stays visible without crashing the PTY spawn.
export function safeRemoveOverlay(overlayDir: string, overlayRoot: string): void {
  const resolvedRoot = resolve(overlayRoot)
  const resolvedTarget = resolve(overlayDir)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    console.warn(
      `[overlay-mirror] refusing to remove overlay outside root: target=${resolvedTarget} root=${resolvedRoot}`
    )
    return
  }
  safeRemoveTree(resolvedTarget)
}
