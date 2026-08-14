import { lstat, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { getPersistedWorkspaceCleanupActivityAt } from '../../shared/workspace-cleanup'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'

type StatPath = (targetPath: string) => Promise<{ mtimeMs: number }>
type ReadTextFile = (targetPath: string, options?: { tailBytes?: number }) => Promise<string>

// Why: only the newest reflog entry matters; a long-lived main worktree's full
// reflog can be megabytes, and it was read and split whole per broad scan.
const REFLOG_TAIL_BYTES = 8192

export function resolvePersistedWorkspaceCleanupActivityWorktree(worktree: Worktree): Worktree {
  const persistedActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
  if (persistedActivityAt <= worktree.lastActivityAt) {
    return worktree
  }
  return { ...worktree, lastActivityAt: persistedActivityAt }
}

export type WorkspaceCleanupFsActivityCache = Map<string, Promise<number>>

export async function resolveWorkspaceCleanupActivityWorktree(
  repo: Repo,
  worktree: Worktree,
  statPath: StatPath = statLocalPath,
  readTextFile: ReadTextFile = readLocalTextFile,
  // Why: folder workspaces surface one row per instance of the same directory;
  // the filesystem probes are identical per path and must run once per scan.
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<Worktree> {
  const activityAt = await resolveWorkspaceCleanupActivityAt(
    repo,
    worktree,
    statPath,
    readTextFile,
    fsActivityCache
  )
  if (activityAt <= worktree.lastActivityAt) {
    return worktree
  }
  return { ...worktree, lastActivityAt: activityAt }
}

async function statLocalPath(targetPath: string): Promise<{ mtimeMs: number }> {
  const stats = await lstat(targetPath)
  return { mtimeMs: Number(stats.mtimeMs) }
}

async function readLocalTextFile(
  targetPath: string,
  options?: { tailBytes?: number }
): Promise<string> {
  if (options?.tailBytes === undefined) {
    return readFile(targetPath, 'utf8')
  }
  const handle = await open(targetPath, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(options.tailBytes, size)
    if (length === 0) {
      return ''
    }
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(length),
      position: size - length
    })
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function resolveWorkspaceCleanupActivityAt(
  repo: Repo,
  worktree: Worktree,
  statPath: StatPath,
  readTextFile: ReadTextFile,
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<number> {
  const persistedActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
  if (repo.connectionId) {
    return persistedActivityAt
  }

  let filesystemActivity = fsActivityCache?.get(worktree.path)
  if (!filesystemActivity) {
    filesystemActivity = getNewestLocalWorktreeActivityAt(worktree.path, statPath, readTextFile)
    fsActivityCache?.set(worktree.path, filesystemActivity)
  }
  return Math.max(persistedActivityAt, await filesystemActivity)
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
    // A tail cut can start mid-line; scanning backward for the last parseable
    // entry tolerates that.
    const tail = await readTextFile(reflogPath, { tailBytes: REFLOG_TAIL_BYTES })
    const newestFromTail = parseNewestReflogEntryAt(tail)
    if (newestFromTail !== 0 || tail.length === 0) {
      return newestFromTail
    }
    // Why: a single record longer than the tail window keeps its timestamp
    // before the window starts; fall back to the full read in that rare case.
    return parseNewestReflogEntryAt(await readTextFile(reflogPath))
  } catch {
    return 0
  }
}

function parseNewestReflogEntryAt(reflog: string): number {
  const lines = reflog.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // The trailing timezone + tab anchors the capture, so no digit-count floor is needed.
    const seconds = /\s(\d{1,11})\s[-+]\d{4}\t/.exec(lines[index] ?? '')?.[1]
    if (seconds) {
      return Number(seconds) * 1000
    }
  }
  return 0
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
