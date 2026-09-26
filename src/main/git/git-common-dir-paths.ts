import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'

/**
 * A repository's common directory, spelled for whichever process is about to
 * open it.
 *
 * Git reports the common dir in its own execution space, so a WSL repo answers
 * with a Linux path the Windows main process cannot open. Anything the main
 * process walks itself has to be translated back to the UNC spelling; anything
 * handed to a Git child has to stay in Git's spelling. Those are two different
 * answers for the same directory, and mixing them silently walks the wrong tree.
 */

/** Resolves a repository's common dir once and caches it for the whole target. */
export type RepoCommonDirResolver = (signal?: AbortSignal) => Promise<string | undefined>

/**
 * The walk reads directories, not files, so the handful of round trips stays
 * cheap even over the WSL share.
 */
function commonDirForMainProcess(commonDir: string, wslDistro: string | undefined): string {
  if (wslDistro && !isWslUncPath(commonDir) && !isWindowsAbsolutePathLike(commonDir)) {
    return toWindowsWslPath(commonDir, wslDistro)
  }
  return commonDir
}

/** Decided by path syntax, not by platform: `win32.isAbsolute` accepts POSIX paths too. */
function joinInSpellingOf(base: string, ...segments: string[]): string {
  return (isWindowsAbsolutePathLike(base) ? win32 : posix).join(base, ...segments)
}

/** Absolute `refs/` path in the spelling the main process can open. */
export function refsDirectoryForMainProcess(
  commonDir: string,
  wslDistro: string | undefined
): string {
  return joinInSpellingOf(commonDirForMainProcess(commonDir, wslDistro), 'refs')
}

/** Absolute `objects/` path in the spelling the main process can open. */
export function objectsDirectoryForMainProcess(
  commonDir: string,
  wslDistro: string | undefined
): string {
  return joinInSpellingOf(commonDirForMainProcess(commonDir, wslDistro), 'objects')
}

/** Absolute `objects/pack/` path in the spelling the main process can open. */
export function packDirectoryForMainProcess(
  commonDir: string,
  wslDistro: string | undefined
): string {
  return joinInSpellingOf(commonDirForMainProcess(commonDir, wslDistro), 'objects', 'pack')
}

/** The common dir itself in the spelling the main process can open. */
export function gitCommonDirForMainProcess(
  commonDir: string,
  wslDistro: string | undefined
): string {
  return commonDirForMainProcess(commonDir, wslDistro)
}

/**
 * Base path for a pack, in *Git's* execution space rather than the main
 * process's: `pack-objects` opens it itself, and a worktree's cwd is not where
 * its object store lives, so a relative path would land in the wrong place.
 */
export function objectPackBaseForGit(commonDir: string, baseName: string): string {
  return joinInSpellingOf(commonDir, 'objects', 'pack', baseName)
}
