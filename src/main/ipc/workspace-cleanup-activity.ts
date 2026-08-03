import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Repo, Worktree } from '../../shared/types'
import { getPersistedWorkspaceCleanupActivityAt } from '../../shared/workspace-cleanup'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'

type StatPath = (targetPath: string) => Promise<{ mtimeMs: number }>
type ReadTextFile = (targetPath: string) => Promise<string>

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
  return readFile(targetPath, 'utf8')
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

  const filesystemActivityAt = await getNewestLocalWorktreeActivityAt(
    worktree.path,
    statPath,
    readTextFile
  )
  return Math.max(persistedActivityAt, filesystemActivityAt)
}

// Why: best-effort only. Win32 stat over \\wsl.localhost (9P) can falsely
// report ENOENT (see wslUncDirectoryExists), so a failed stat degrades to the
// persisted activity timestamp instead of blocking or mislabeling the row.
async function getNewestLocalWorktreeActivityAt(
  worktreePath: string,
  statPath: StatPath,
  readTextFile: ReadTextFile
): Promise<number> {
  const gitPath = path.join(worktreePath, '.git')
  const gitDirPath = await readLocalWorktreeGitDir(worktreePath, gitPath, readTextFile)
  // Why: every entry here must move only on a user action. Excluded on purpose:
  // the gitdir directory and logs/HEAD (restamped for every linked worktree at
  // once by `git gc` / `git reflog expire`, which made one maintenance run look
  // like activity everywhere), and index (rewritten by `git status` — this scan
  // runs one per candidate, so it would erase the evidence it just read).
  const gitDirProbes = gitDirPath
    ? [
        readMtime(path.join(gitDirPath, 'HEAD'), statPath),
        readMtime(path.join(gitDirPath, 'COMMIT_EDITMSG'), statPath),
        readMtime(path.join(gitDirPath, 'ORIG_HEAD'), statPath),
        readNewestReflogEntryAt(path.join(gitDirPath, 'logs', 'HEAD'), readTextFile)
      ]
    : []
  const timestamps = await Promise.all([
    readMtime(worktreePath, statPath),
    readMtime(gitPath, statPath),
    ...gitDirProbes
  ])
  return Math.max(0, ...timestamps)
}

// Why: the reflog records when HEAD actually moved, so it survives the mtime
// churn that makes logs/HEAD itself unreadable as a signal. Expired reflogs are
// truncated to an empty file, which degrades to the other probes.
async function readNewestReflogEntryAt(
  reflogPath: string,
  readTextFile: ReadTextFile
): Promise<number> {
  try {
    const lines = (await readTextFile(reflogPath)).split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      // The trailing timezone + tab anchors the capture, so no digit-count floor is needed.
      const seconds = /\s(\d{1,11})\s[-+]\d{4}\t/.exec(lines[index] ?? '')?.[1]
      if (seconds) {
        return Number(seconds) * 1000
      }
    }
    return 0
  } catch {
    return 0
  }
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
