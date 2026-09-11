/**
 * Deciding whether a worktree-removal path is somebody's home directory — and
 * whose home the caller is even allowed to ask about.
 *
 * `os.homedir()` answers for the process running Orca. A removal routed to an
 * SSH host deletes on a different machine, with a different OS and a different
 * home, so the client answer is neither necessary nor sufficient there: a
 * Windows host profile (`C:\Users\bob`) went unrecognised from a macOS desktop
 * and a coincidental client-home prefix could refuse a legitimate remote
 * delete (#18275). Callers therefore name the machine they mean, and the
 * ambient read is reachable only through `{ kind: 'client' }`.
 *
 * Everything else here is decided from path SYNTAX, which travels: a Windows
 * profile is a Windows profile no matter which desktop is looking at it.
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { parseWslUncPath } from '../shared/wsl-paths'

export type PathOps = typeof posix

/** Whose home directory the guard may consult for a given removal. */
export type WorktreeRemovalHomeAuthority =
  /** The removal runs on this machine, so `os.homedir()` is authoritative. */
  | { kind: 'client' }
  /** The removal runs elsewhere; `homePath` is what that host reported, if anything. */
  | { kind: 'executionHost'; homePath: string | null }

export const CLIENT_REMOVAL_HOME: WorktreeRemovalHomeAuthority = { kind: 'client' }

export function executionHostRemovalHome(
  homePath: string | null | undefined
): WorktreeRemovalHomeAuthority {
  return { kind: 'executionHost', homePath: homePath ?? null }
}

export function getPathOps(...paths: string[]): PathOps {
  // Why: forward-slash UNC roots need win32 ops; POSIX joins collapse `//Server` to `/Server`.
  return paths.some(isWindowsAbsolutePathLike) ? win32 : posix
}

export function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath)
  // Why: `..name` is a valid child name; only `..` and `../...` escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathOps.sep}`) &&
      !pathOps.isAbsolute(relativePath))
  )
}

/**
 * Whether removing `worktreePath` would take a home directory with it.
 *
 * True when the path is, or contains, the home of the machine that executes the
 * removal, or when its shape is a home directory on the filesystem it names.
 *
 * Why the ops are re-derived from `worktreePath` alone: whose home a path is, is
 * a property of that path and nothing else. The caller's `getPathOps(worktreePath,
 * repoPath)` lets the *repo* spelling vote, and a WSL project is registered as
 * `\\wsl.localhost\<distro>\...` while git-in-the-distro answers in Linux paths
 * (`toWslExecutionSpace`), so the pair picked win32 and every POSIX home shape
 * went quiet — `/home/<user>` read back as an ordinary deletable directory.
 */
export function isHomeDirectoryRemovalPath(
  worktreePath: string,
  home: WorktreeRemovalHomeAuthority
): boolean {
  const pathOps = getPathOps(worktreePath)
  const resolvedWorktreePath = pathOps.resolve(worktreePath)
  const homePath = resolveGuardHomePath(home, pathOps)
  if (!!homePath && containsPath(resolvedWorktreePath, pathOps.resolve(homePath), pathOps)) {
    return true
  }
  return (
    isLikelyPosixHomeDirectory(resolvedWorktreePath, pathOps) ||
    isLikelyWindowsUserProfileDirectory(resolvedWorktreePath, pathOps) ||
    isLikelyWslDistroHomeDirectory(resolvedWorktreePath, pathOps)
  )
}

/**
 * The home path this guard is allowed to compare against, or `null`.
 *
 * A home only answers for paths written in its own syntax. Comparing
 * `C:\Users\bob` against a POSIX client home is meaningless in both directions:
 * it cannot prove danger, and `path.resolve` would happily manufacture a
 * relative answer that means nothing.
 */
function resolveGuardHomePath(home: WorktreeRemovalHomeAuthority, pathOps: PathOps): string | null {
  if (home.kind === 'executionHost') {
    return home.homePath && getPathOps(home.homePath) === pathOps ? home.homePath : null
  }
  const clientPathOps = process.platform === 'win32' ? win32 : posix
  return pathOps === clientPathOps ? homedir() : null
}

function isLikelyPosixHomeDirectory(resolvedWorktreePath: string, pathOps: PathOps): boolean {
  return pathOps === posix && isPosixHomeShape(resolvedWorktreePath)
}

function isPosixHomeShape(linuxPath: string): boolean {
  return (
    linuxPath === '/home' ||
    linuxPath === '/root' ||
    linuxPath === '/Users' ||
    /^\/home\/[^/]+$/.test(linuxPath) ||
    /^\/Users\/[^/]+$/.test(linuxPath)
  )
}

/**
 * `C:\Users`, `C:\Users\bob` and their UNC equivalents, from path syntax alone.
 *
 * The drive letter comes from `parse().root`, so this holds for any volume and
 * for `\\server\share\Users\bob`, not just `C:`.
 */
function isLikelyWindowsUserProfileDirectory(
  resolvedWorktreePath: string,
  pathOps: PathOps
): boolean {
  if (pathOps !== win32 || isWslUncRemovalPath(resolvedWorktreePath)) {
    return false
  }
  const parsed = win32.parse(resolvedWorktreePath)
  if (!parsed.root) {
    return false
  }
  const usersRoot = win32.join(parsed.root, 'Users')
  return (
    equalsWindowsPath(resolvedWorktreePath, usersRoot) ||
    (equalsWindowsPath(parsed.dir, usersRoot) && parsed.base.length > 0)
  )
}

/**
 * WSL UNC aliases front a Linux filesystem, so POSIX home shapes — not
 * `<root>\Users` — are what protect `\\wsl.localhost\Ubuntu\home\alice`.
 */
function isLikelyWslDistroHomeDirectory(resolvedWorktreePath: string, pathOps: PathOps): boolean {
  if (pathOps !== win32) {
    return false
  }
  const wsl = parseWslUncPath(resolvedWorktreePath)
  return !!wsl && (wsl.linuxPath === '/' || isPosixHomeShape(trimTrailingSlash(wsl.linuxPath)))
}

function isWslUncRemovalPath(resolvedWorktreePath: string): boolean {
  return parseWslUncPath(resolvedWorktreePath) !== null
}

function trimTrailingSlash(linuxPath: string): string {
  return linuxPath.length > 1 ? linuxPath.replace(/\/+$/, '') : linuxPath
}

// Why: Windows drive and UNC roots fold case, so `c:\users\bob` is the same profile.
function equalsWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}
