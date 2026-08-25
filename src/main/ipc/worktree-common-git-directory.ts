import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import {
  getRuntimePathBasename,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import type { FileStat } from '../providers/types'

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
  if (index === -1) {
    return '.'
  }
  if (index === 0) {
    return '/'
  }
  return normalized.slice(0, index)
}
export type WorktreeCommonGitDirectoryProbe = {
  path: string | null
  transientFailure: boolean
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export async function probeWorktreeCommonGitDirectory(
  repo: Repo,
  access: GitDirectoryAccess = {}
): Promise<WorktreeCommonGitDirectoryProbe> {
  const dotGitPath = resolveRuntimePath(repo.path, '.git')
  const statPath = access.stat ?? stat
  const readText = access.readFile ?? ((path: string) => readFile(path, 'utf8'))
  try {
    const dotGitStat = await statPath(dotGitPath)
    if (isDirectoryStat(dotGitStat)) {
      return { path: dotGitPath, transientFailure: false }
    }
    if (!isFileStat(dotGitStat)) {
      return { path: null, transientFailure: false }
    }
    const content = await readText(dotGitPath)
    const gitDir = content.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim()
    if (!gitDir) {
      return { path: null, transientFailure: false }
    }
    const resolvedGitDir = resolveRuntimePath(repo.path, gitDir)
    return {
      path:
        getRuntimePathBasename(runtimeDirname(resolvedGitDir)) === 'worktrees'
          ? runtimeDirname(runtimeDirname(resolvedGitDir))
          : resolvedGitDir,
      transientFailure: false
    }
  } catch (error) {
    console.warn(`[worktree-base-watcher] cannot resolve git common dir for ${repo.id}:`, error)
    return { path: null, transientFailure: !isMissingPathError(error) }
  }
}
