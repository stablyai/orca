import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { Stats } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'

export type ClaimedCloneTarget = {
  canCleanup: boolean
  ownedDirectoryIdentity: CloneDirectoryIdentity | null
}

type CloneDirectoryIdentity = Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>

export function deriveCloneRepoNameFromUrl(url: string): string {
  // Reject dot destinations before cleanup could remove a parent or unrelated folder.
  const source = url.replace(/\.git\/?$/, '')
  const isWindowsLocalSource = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\')
  const scpPath =
    !isWindowsLocalSource && !source.includes('://')
      ? source.match(/^(?:[^@/:]+@)?(?:\[[^\]]+\]|[^:/\s]+):(.+)$/)?.[1]
      : undefined
  const repoName = isWindowsLocalSource ? win32.basename(source) : posix.basename(scpPath ?? source)
  if (!repoName || repoName === '.' || repoName === '..') {
    throw new Error('Invalid repository name derived from URL')
  }
  if (repoName.includes('/') || repoName.includes('\\')) {
    throw new Error('Invalid repository name derived from URL')
  }
  return repoName
}

export function deriveValidatedClonePath(args: { url: string; destination: string }): string {
  if (
    !args.destination ||
    !isAbsolute(args.destination) ||
    (process.platform !== 'win32' && isWindowsAbsolutePathLike(args.destination))
  ) {
    throw new Error('Clone destination must be an absolute path')
  }

  const repoName = deriveCloneRepoNameFromUrl(args.url)

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
