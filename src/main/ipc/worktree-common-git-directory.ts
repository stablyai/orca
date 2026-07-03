import { readFile, stat } from 'node:fs/promises'
import type { Repo } from '../../shared/types'
import {
  getRuntimePathBasename,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import type { FileStat } from '../providers/types'

type GitDirectoryStat = Awaited<ReturnType<typeof stat>> | FileStat

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
  const readText = access.readFile ?? ((path: string) => readFile(path, 'utf8'))
  try {
    const dotGitStat = await statPath(dotGitPath)
    if (isDirectoryStat(dotGitStat)) {
      return dotGitPath
    }
    if (!isFileStat(dotGitStat)) {
      return null
    }
    const content = await readText(dotGitPath)
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
