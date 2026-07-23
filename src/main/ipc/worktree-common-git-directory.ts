import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Repo } from '../../shared/types'
import {
  getRuntimePathBasename,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import type { FileStat } from '../providers/types'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'

export const MAX_GIT_DIRECTORY_POINTER_BYTES = 64 * 1024

type GitDirectoryStat = Stats | FileStat

type GitDirectoryAccess = {
  stat?: (path: string) => Promise<GitDirectoryStat>
  readFile?: (path: string) => Promise<string>
}

function isDirectoryStat(value: GitDirectoryStat): boolean {
  return 'type' in value ? value.type === 'directory' : value.isDirectory()
}

function isFileStat(value: GitDirectoryStat): boolean {
  return 'type' in value ? value.type === 'file' : value.isFile()
}

function runtimeDirname(pathValue: string): string {
  const normalized = normalizeRuntimePathSeparators(pathValue).replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index < 0) {
    return '.'
  }
  if (index === 0) {
    return '/'
  }
  return normalized.slice(0, index)
}

export async function resolveWorktreeCommonGitDirectory(
  repo: Repo,
  access: GitDirectoryAccess = {}
): Promise<string | null> {
  const dotGitPath = resolveRuntimePath(repo.path, '.git')
  const statPath = access.stat ?? stat
  const readText =
    access.readFile ??
    (async (path: string) =>
      (await readNodeFileWithinLimit(path, MAX_GIT_DIRECTORY_POINTER_BYTES)).buffer.toString(
        'utf8'
      ))
  try {
    const dotGitStat = await statPath(dotGitPath)
    if (isDirectoryStat(dotGitStat)) {
      return dotGitPath
    }
    if (!isFileStat(dotGitStat)) {
      return null
    }
    const content = await readText(dotGitPath)
    if (Buffer.byteLength(content, 'utf8') > MAX_GIT_DIRECTORY_POINTER_BYTES) {
      return null
    }
    const gitDir = content.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim()
    if (!gitDir) {
      return null
    }
    const resolvedGitDir = resolveRuntimePath(repo.path, gitDir)
    return getRuntimePathBasename(runtimeDirname(resolvedGitDir)) === 'worktrees'
      ? runtimeDirname(runtimeDirname(resolvedGitDir))
      : resolvedGitDir
  } catch (error) {
    console.warn(`[worktree-base-watcher] cannot resolve git common dir for ${repo.id}:`, error)
    return null
  }
}
