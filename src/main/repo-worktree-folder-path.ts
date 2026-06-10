import { posix, win32 } from 'path'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/types'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { parseWslUncPath } from '../shared/wsl-paths'

const WSL_DRIVE_MOUNT_PATTERN = /^\/mnt\/[a-z](?:\/|$)/i

type RepoWorktreeFolderPathRepo = Pick<Repo, 'path' | 'kind'>

export function normalizeRepoWorktreeFolderPath(
  value: unknown,
  repo: RepoWorktreeFolderPathRepo
): string | undefined {
  if (isFolderRepo(repo)) {
    return undefined
  }
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Worktree folder path must be a string.')
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (containsControlCharacter(trimmed)) {
    throw new Error('Worktree folder path cannot contain control characters.')
  }

  const wslRepo = parseWslUncPath(repo.path)
  if (wslRepo) {
    return normalizeWslRepoWorktreeFolderPath(trimmed, wslRepo.distro)
  }

  if (isWindowsAbsolutePathLike(repo.path)) {
    return normalizeWindowsRepoWorktreeFolderPath(trimmed)
  }

  return normalizePosixRepoWorktreeFolderPath(trimmed)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

function normalizeWslRepoWorktreeFolderPath(value: string, distro: string): string {
  if (isWindowsDrivePath(value)) {
    throw new Error('WSL worktree folders must stay inside the WSL distro filesystem.')
  }

  const wslInput = parseWslUncPath(value)
  if (wslInput) {
    if (wslInput.distro.toLowerCase() !== distro.toLowerCase()) {
      throw new Error('WSL worktree folders must stay in the same distro as the repo.')
    }
    return wslLinuxPathToUnc(normalizeWslLinuxPath(wslInput.linuxPath), distro)
  }

  if (isWindowsAbsolutePathLike(value)) {
    throw new Error('WSL worktree folders must stay inside the WSL distro filesystem.')
  }
  if (!value.startsWith('/')) {
    throw new Error('Worktree folder path must be absolute.')
  }
  return wslLinuxPathToUnc(normalizeWslLinuxPath(value), distro)
}

function normalizeWslLinuxPath(value: string): string {
  const normalized = posix.normalize(value)
  if (normalized === '/') {
    throw new Error('Worktree folder path cannot be a filesystem root.')
  }
  if (WSL_DRIVE_MOUNT_PATTERN.test(normalized)) {
    throw new Error('WSL worktree folders cannot use /mnt/<drive> paths.')
  }
  return normalized
}

function wslLinuxPathToUnc(linuxPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function normalizeWindowsRepoWorktreeFolderPath(value: string): string {
  if (!isWindowsAbsolutePathLike(value)) {
    throw new Error('Worktree folder path must be absolute for the repo runtime.')
  }
  const normalized = win32.normalize(value)
  if (isWindowsFilesystemRoot(normalized)) {
    throw new Error('Worktree folder path cannot be a filesystem root.')
  }
  return normalized
}

function normalizePosixRepoWorktreeFolderPath(value: string): string {
  if (isWindowsAbsolutePathLike(value)) {
    throw new Error('Worktree folder path must be absolute for the repo runtime.')
  }
  if (!value.startsWith('/')) {
    throw new Error('Worktree folder path must be absolute.')
  }
  const normalized = posix.normalize(value)
  if (normalized === '/') {
    throw new Error('Worktree folder path cannot be a filesystem root.')
  }
  return normalized
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function isWindowsFilesystemRoot(value: string): boolean {
  const normalized = win32.normalize(value)
  const parsed = win32.parse(normalized)
  return trimWindowsRoot(normalized).toLowerCase() === trimWindowsRoot(parsed.root).toLowerCase()
}

function trimWindowsRoot(value: string): string {
  return value.replace(/[\\/]+$/g, '')
}
