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
  // Why `||`: an empty answer is an absent one, and `''` would otherwise read as a resolved home.
  return { kind: 'executionHost', homePath: homePath || null }
}

/**
 * Whether the host that executes the removal actually named its home directory.
 *
 * `false` is `unverifiable`, not "no home here" (docs/reference/ssh-execution-boundary.md). Every
 * gate in `worktree-removal-safety.ts` that authorises a delete requires `true`, because nothing
 * else in reach rules out a home directory:
 *
 *   - The orphan gates accept a `.git` file at the top of a directory as proof, which is also what
 *     a bare-repo dotfiles `$HOME` looks like.
 *   - The registry does not help either. `git worktree add` takes a pre-existing empty directory,
 *     and that directory can afterwards be somebody's `$HOME` — a build account's home, a
 *     container's `HOME=/workspace`. Being a linked worktree of the repo proves provenance, not
 *     that the path is not a home, and `git worktree remove --force` deletes the checkout.
 *
 * With the host's answer both are caught by containment. Without it only the path shapes remain,
 * and a home at a non-standard location has no shape to match.
 */
export function isRemovalHomeAuthorityResolved(home: WorktreeRemovalHomeAuthority): boolean {
  return home.kind === 'client' || !!home.homePath
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
 * removal, or when its shape is a home directory on the filesystem it names. An
 * execution host that never reported a home answers neither — see
 * `isRemovalHomeAuthorityResolved` for who has to insist on an answer.
 */
export function isHomeDirectoryRemovalPath(
  worktreePath: string,
  pathOps: PathOps,
  home: WorktreeRemovalHomeAuthority
): boolean {
  if (isHomeUnderPathOps(worktreePath, pathOps, home)) {
    return true
  }
  // Why: `pathOps` is picked from the worktree/repo PAIR, so a Windows-shaped repo path drags a
  // POSIX worktree path into win32 rules and `/home/alice` stops matching anything. Read the path
  // in its own syntax as well, and refuse if either reading names a home.
  const ownPathOps = getPathOps(worktreePath)
  return ownPathOps !== pathOps && isHomeUnderPathOps(worktreePath, ownPathOps, home)
}

function isHomeUnderPathOps(
  worktreePath: string,
  pathOps: PathOps,
  home: WorktreeRemovalHomeAuthority
): boolean {
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
  return pathOps === posix && isPosixHomeRoot(resolvedWorktreePath)
}

function isPosixHomeRoot(linuxPath: string): boolean {
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
  return !!wsl && (wsl.linuxPath === '/' || isPosixHomeRoot(trimTrailingSlash(wsl.linuxPath)))
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
