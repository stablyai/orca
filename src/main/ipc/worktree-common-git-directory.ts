import { readFile, stat } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import {
  getRuntimePathBasename,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from '../../shared/cross-platform-path'

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

export async function resolveWorktreeCommonGitDirectory(repo: Repo): Promise<string | null> {
  const dotGitPath = resolveRuntimePath(repo.path, '.git')
  try {
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isDirectory()) {
      return dotGitPath
    }
    if (!dotGitStat.isFile()) {
      return null
    }
    const content = await readFile(dotGitPath, 'utf8')
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
