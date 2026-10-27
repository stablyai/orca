import { lstat, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Worktree } from '../../shared/worktree/types'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import { getPersistedWorkspaceCleanupActivityAt } from '../../shared/workspace-cleanup'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'

type StatPath = (targetPath: string) => Promise<{ mtimeMs: number }>
type ReadTextFile = (targetPath: string, options?: { tailBytes?: number }) => Promise<string>

// Read only the newest reflog entry; full histories can span megabytes per checkout.
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
  route: WorkspaceCleanupGitRoute,
  worktree: Worktree,
  statPath: StatPath = statLocalPath,
  readTextFile: ReadTextFile = readLocalTextFile,
  // Folder workspace instances share filesystem probes; cache by path for this scan.
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<Worktree> {
  const activityAt = await resolveWorkspaceCleanupActivityAt(
    route,
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
  route: WorkspaceCleanupGitRoute,
  worktree: Worktree,
  statPath: StatPath,
  readTextFile: ReadTextFile,
  fsActivityCache?: WorkspaceCleanupFsActivityCache
): Promise<number> {
  const persistedActivityAt = getPersistedWorkspaceCleanupActivityAt(worktree)
  // Remote paths cannot establish activity through this client's local filesystem.
  if (route.kind !== 'local') {
    return persistedActivityAt
  }

  let filesystemActivity = fsActivityCache?.get(worktree.path)
  if (!filesystemActivity) {
    filesystemActivity = getNewestLocalWorktreeActivityAt(worktree.path, statPath, readTextFile)
    fsActivityCache?.set(worktree.path, filesystemActivity)
  }
  return Math.max(persistedActivityAt, await filesystemActivity)
}

// WSL UNC stat can falsely return ENOENT; retain persisted activity when filesystem probes fail.
async function getNewestLocalWorktreeActivityAt(
  worktreePath: string,
  statPath: StatPath,
  readTextFile: ReadTextFile
): Promise<number> {
  const gitPath = path.join(worktreePath, '.git')
  const gitDirPath = await readLocalWorktreeGitDir(worktreePath, gitPath, readTextFile)
  // Exclude gitdir/log mtimes touched by maintenance and index rewritten by this scan's own git status.
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

// Reflog entry times survive metadata churn; empty expired logs fall back to other probes.
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
    // Oversized entries can place their timestamp before the tail window.
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
    // Linked Git metadata is external; resolve pointers in the writing Git's namespace, including WSL guest paths.
    return resolveGitMetadataPath(worktreePath, gitDir)
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
