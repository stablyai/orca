import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Repo, Worktree } from '../../shared/types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { MAX_WORKTREE_GIT_POINTER_BYTES } from '../worktree-orphan-gitdir-proof'

type StatPath = (targetPath: string) => Promise<{ mtimeMs: number }>
type ReadTextFile = (targetPath: string) => Promise<string>

export function getPersistedWorkspaceCleanupActivityAt(
  worktree: Pick<Worktree, 'createdAt' | 'lastActivityAt'>
): number {
  const persistedActivityAt = Number.isFinite(worktree.lastActivityAt) ? worktree.lastActivityAt : 0
  const createdAt = Number.isFinite(worktree.createdAt) ? (worktree.createdAt ?? 0) : 0
  return Math.max(persistedActivityAt, createdAt)
}

export function resolvePersistedWorkspaceCleanupActivityWorktree(worktree: Worktree): Worktree {
  const persistedActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
  if (persistedActivityAt <= worktree.lastActivityAt) {
    return worktree
  }
  return { ...worktree, lastActivityAt: persistedActivityAt }
}

export async function resolveWorkspaceCleanupActivityWorktree(
  repo: Repo,
  worktree: Worktree,
  statPath: StatPath = statLocalPath,
  readTextFile: ReadTextFile = readLocalTextFile
): Promise<Worktree> {
  const activityAt = await resolveWorkspaceCleanupActivityAt(repo, worktree, statPath, readTextFile)
  if (activityAt <= worktree.lastActivityAt) {
    return worktree
  }
  return { ...worktree, lastActivityAt: activityAt }
}

async function statLocalPath(targetPath: string): Promise<{ mtimeMs: number }> {
  const stats = await lstat(targetPath)
  return { mtimeMs: Number(stats.mtimeMs) }
}

async function readLocalTextFile(targetPath: string): Promise<string> {
  return (
    await readNodeFileWithinLimit(targetPath, MAX_WORKTREE_GIT_POINTER_BYTES)
  ).buffer.toString('utf8')
}

async function resolveWorkspaceCleanupActivityAt(
  repo: Repo,
  worktree: Worktree,
  statPath: StatPath,
  readTextFile: ReadTextFile
): Promise<number> {
  const persistedActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
  if (repo.connectionId) {
    return persistedActivityAt
  }

  const filesystemActivityAt = await getNewestLocalWorktreeStatMtime(
    worktree.path,
    statPath,
    readTextFile
  )
  return Math.max(persistedActivityAt, filesystemActivityAt)
}

// Why: best-effort only. Win32 stat over \\wsl.localhost (9P) can falsely
// report ENOENT (see wslUncDirectoryExists), so a failed stat degrades to the
// persisted activity timestamp instead of blocking or mislabeling the row.
async function getNewestLocalWorktreeStatMtime(
  worktreePath: string,
  statPath: StatPath,
  readTextFile: ReadTextFile
): Promise<number> {
  const gitPath = path.join(worktreePath, '.git')
  const gitDirPath = await readLocalWorktreeGitDir(worktreePath, gitPath, readTextFile)
  const gitDirMtimePromises = gitDirPath
    ? [
        readMtime(gitDirPath, statPath),
        readMtime(path.join(gitDirPath, 'HEAD'), statPath),
        readMtime(path.join(gitDirPath, 'logs', 'HEAD'), statPath)
      ]
    : []
  const mtimes = await Promise.all([
    readMtime(worktreePath, statPath),
    readMtime(gitPath, statPath),
    ...gitDirMtimePromises
  ])
  return Math.max(0, ...mtimes)
}

async function readLocalWorktreeGitDir(
  worktreePath: string,
  gitPath: string,
  readTextFile: ReadTextFile
): Promise<string | null> {
  try {
    const contents = await readTextFile(gitPath)
    const match = /^gitdir:\s*(.+)\s*$/im.exec(contents)
    if (!match) {
      return null
    }
    const gitDir = match[1]?.trim()
    if (!gitDir) {
      return null
    }
    // Why: linked worktrees keep mutable git state outside the worktree; the
    // pointer file mtime alone can miss recent external commits.
    const wslWorktree = parseWslUncPath(worktreePath)
    if (wslWorktree && gitDir.startsWith('/')) {
      return toWindowsWslPath(gitDir, wslWorktree.distro)
    }
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir)
  } catch {
    return null
  }
}

async function readMtime(targetPath: string, statPath: StatPath): Promise<number> {
  try {
    const stats = await statPath(targetPath)
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0
  } catch {
    return 0
  }
}
