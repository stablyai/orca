/** Home-directory protection must use the executing host's home and the target path's syntax. */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { parseWslUncPath, toWindowsWslDrivePath } from '../shared/wsl-paths'

export type PathOps = typeof posix

export type WorktreeRemovalHomeAuthority =
  /** os.homedir() is authoritative only for this machine. */
  | { kind: 'client' }
  /** Null means the executing host has not reported its home. */
  | { kind: 'executionHost'; homePath: string | null }

export const CLIENT_REMOVAL_HOME: WorktreeRemovalHomeAuthority = { kind: 'client' }

export function executionHostRemovalHome(
  homePath: string | null | undefined
): WorktreeRemovalHomeAuthority {
  return { kind: 'executionHost', homePath: homePath || null }
}

/** Unknown home must block deletion: even a registered worktree or .git file can be inside a nonstandard home. */
export function isRemovalHomeAuthorityResolved(home: WorktreeRemovalHomeAuthority): boolean {
  return home.kind === 'client' || !!home.homePath
}

export function getPathOps(...paths: string[]): PathOps {
  // POSIX joins collapse forward-slash UNC roots from //Server to /Server.
  return paths.some(isWindowsAbsolutePathLike) ? win32 : posix
}

export function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath)
  // ..name is a child name; only .. and ../... escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathOps.sep}`) &&
      !pathOps.isAbsolute(relativePath))
  )
}

/** Check host-home containment and known home shapes; callers must separately require a resolved home. */
export function isHomeDirectoryRemovalPath(
  worktreePath: string,
  pathOps: PathOps,
  home: WorktreeRemovalHomeAuthority
): boolean {
  if (isHomeUnderPathOps(worktreePath, pathOps, home)) {
    return true
  }
  // A Windows repo can select win32 ops for a POSIX worktree; check the worktree's own syntax too.
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

/** Compare homes only under their own path syntax; cross-syntax resolve can invent meaningless containment. */
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

/** WSL uses Linux home shapes except under /mnt/<drive>, which names a Windows volume. */
function isLikelyWslDistroHomeDirectory(resolvedWorktreePath: string, pathOps: PathOps): boolean {
  if (pathOps !== win32) {
    return false
  }
  const wsl = parseWslUncPath(resolvedWorktreePath)
  if (!wsl) {
    return false
  }
  const linuxPath = trimTrailingSlash(wsl.linuxPath)
  const drivePath = toWindowsWslDrivePath(linuxPath)
  if (drivePath) {
    const resolvedDrivePath = win32.resolve(drivePath)
    // The UNC root is the distro share, so explicitly protect the drvfs volume root too.
    return (
      win32.parse(resolvedDrivePath).root === resolvedDrivePath ||
      isLikelyWindowsUserProfileDirectory(resolvedDrivePath, win32)
    )
  }
  // /mnt contains every mounted Windows volume and its profiles.
  return wsl.linuxPath === '/' || linuxPath === '/mnt' || isPosixHomeRoot(linuxPath)
}

function isWslUncRemovalPath(resolvedWorktreePath: string): boolean {
  return parseWslUncPath(resolvedWorktreePath) !== null
}

function trimTrailingSlash(linuxPath: string): string {
  return linuxPath.length > 1 ? linuxPath.replace(/\/+$/, '') : linuxPath
}

function equalsWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}
