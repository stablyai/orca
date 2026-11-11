import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { Stats } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'
import { resolveCreatePathAlias } from '../workspaces/creation/worktree-create-in-flight'

export type ClaimedCloneTarget = {
  canCleanup: boolean
  ownedDirectoryIdentity: CloneDirectoryIdentity | null
}

type CloneDirectoryIdentity = Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>

/** Path part of a clone source: scp-style host prefixes removed, URL schemes kept. */
function cloneSourcePath(url: string): { path: string; windows: boolean } {
  const source = url.replace(/\.git\/?$/, '')
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\')) {
    return { path: source, windows: true }
  }
  const scpPath = !source.includes('://')
    ? source.match(/^(?:[^@/:]+@)?(?:\[[^\]]+\]|[^:/\s]+):(.+)$/)?.[1]
    : undefined
  return { path: scpPath ?? source, windows: false }
}

function assertCloneFolderName(name: string, message: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(message)
  }
  return name
}

export function deriveCloneRepoNameFromUrl(url: string): string {
  // Reject dot destinations before cleanup could remove a parent or unrelated folder.
  const { path, windows } = cloneSourcePath(url)
  const repoName = windows ? win32.basename(path) : posix.basename(path)
  return assertCloneFolderName(repoName, 'Invalid repository name derived from URL')
}

/** The segment above the repository (GitHub owner, GitLab group), or null when there is none. */
export function deriveCloneOwnerFromUrl(url: string): string | null {
  const { path, windows } = cloneSourcePath(url)
  const pathOps = windows ? win32 : posix
  const repoPath = windows ? path : path.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '')
  const owner = pathOps.basename(pathOps.dirname(repoPath))
  return owner && owner !== '.' && owner !== '..' && !owner.includes(':') ? owner : null
}

export function deriveValidatedClonePath(args: {
  url: string
  destination: string
  folderName?: string
}): string {
  if (
    !args.destination ||
    !isAbsolute(args.destination) ||
    (process.platform !== 'win32' && isWindowsAbsolutePathLike(args.destination))
  ) {
    throw new Error('Clone destination must be an absolute path')
  }

  const requestedFolderName = args.folderName?.trim()
  const repoName = requestedFolderName
    ? assertCloneFolderName(requestedFolderName, 'Invalid clone folder name')
    : deriveCloneRepoNameFromUrl(args.url)

  const clonePath = join(args.destination, repoName)
  const resolvedDestination = resolve(args.destination)
  const resolvedClonePath = resolve(clonePath)
  const pathFromDestination = relative(resolvedDestination, resolvedClonePath)
  if (
    pathFromDestination === '' ||
    pathFromDestination === '..' ||
    pathFromDestination.startsWith(`..${sep}`) ||
    isAbsolute(pathFromDestination)
  ) {
    throw new Error('Clone path must be inside the destination directory')
  }

  return clonePath
}

/** Git-registered projects save Git's resolved checkout path, so a folder reached through a
 *  symlink matches by its resolved spelling as well as the typed one. */
export async function getSavedProjectPathKeys(path: string): Promise<string[]> {
  // A clone target may not exist yet (or was deleted); its existing ancestors still resolve.
  const resolved = await resolveCreatePathAlias(path)
  return [...new Set([getClonePathComparisonKey(path), getClonePathComparisonKey(resolved)])]
}

export function getClonePathComparisonKey(clonePath: string): string {
  const resolvedClonePath = isWindowsAbsolutePathLike(clonePath) ? clonePath : resolve(clonePath)
  const normalized = normalizeRuntimePathSeparators(resolvedClonePath)
  const wslUncMatch = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (wslUncMatch) {
    // WSL paths stay case-sensitive after the UNC server/distro prefix.
    const linuxPath = (wslUncMatch[2] ?? '').replace(/\/+$/, '')
    return `//wsl/${wslUncMatch[1].toLowerCase()}${linuxPath}`
  }
  return normalizeRuntimePathForComparison(resolvedClonePath)
}

export async function claimCloneTarget(clonePath: string): Promise<ClaimedCloneTarget> {
  try {
    await mkdir(clonePath, { recursive: false })
    return {
      canCleanup: true,
      ownedDirectoryIdentity: cloneDirectoryIdentity(await lstat(clonePath))
    }
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      return { canCleanup: false, ownedDirectoryIdentity: null }
    }
    throw error
  }
}

export async function cleanupClaimedCloneTarget(
  clonePath: string,
  claimedTarget: ClaimedCloneTarget
): Promise<void> {
  if (!claimedTarget.canCleanup || !claimedTarget.ownedDirectoryIdentity) {
    return
  }

  try {
    const currentStats = await lstat(clonePath)
    if (!currentStats.isDirectory()) {
      return
    }
    if (
      !isSameCloneDirectoryIdentity(
        claimedTarget.ownedDirectoryIdentity,
        cloneDirectoryIdentity(currentStats)
      )
    ) {
      return
    }
  } catch {
    return
  }

  await rm(clonePath, { recursive: true, force: true }).catch(() => {})
}

function cloneDirectoryIdentity(stats: Stats): CloneDirectoryIdentity {
  // Birthtime distinguishes replacements when rapid remove/create cycles reuse an inode.
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs }
}

function isSameCloneDirectoryIdentity(
  a: CloneDirectoryIdentity,
  b: CloneDirectoryIdentity
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
