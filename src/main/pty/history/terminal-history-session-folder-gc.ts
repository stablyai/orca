// Daemon session folders record no owner in meta.json; their name is the session id, which embeds the worktree id.

import { lstat, opendir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../../../shared/worktree/id'
import { isTerminalHistorySessionDirRecoveryProtected } from '../../daemon/history/storage/terminal-history-recovery-quarantine'

export type SessionFolderGcOwners = {
  /** Repos only this machine hosts; only their worktrees can be proven gone by a local stat. */
  localRepoPaths: ReadonlyMap<string, string>
  /** Every daemon session still running, whatever its worktree. */
  liveSessionIds: ReadonlySet<string>
  /** The candidates a saved tab, layout or group still references, on any host. */
  persistedSessionOwners: (candidateWorktreeIds: ReadonlySet<string>) => ReadonlySet<string>
}

export type SessionFolderGcScan = SessionFolderGcOwners & {
  liveWorktreeIds: ReadonlySet<string>
  goneByWorktreeId: Map<string, Promise<boolean>>
  dirHasEntriesByPath: Map<string, Promise<boolean>>
  candidates: { root: string; entryPath: string; worktreeId: string }[]
}

/** Null for folders whose name does not prove a git worktree owner. */
export function sessionFolderOwner(name: string): { sessionId: string; worktreeId: string } | null {
  let sessionId: string
  try {
    sessionId = decodeURIComponent(name)
  } catch {
    return null
  }
  const { worktreeId } = parsePtySessionId(sessionId)
  if (!worktreeId || parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return null
  }
  return { sessionId, worktreeId }
}

/** Prune only a stopped session of a forgotten worktree whose folder is gone from a reachable volume. */
export async function isSessionFolderOfGoneWorktree(
  entryPath: string,
  owner: { sessionId: string; worktreeId: string },
  scan: SessionFolderGcScan
): Promise<boolean> {
  if (
    scan.liveWorktreeIds.has(owner.worktreeId) ||
    scan.liveSessionIds.has(owner.sessionId) ||
    isTerminalHistorySessionDirRecoveryProtected(entryPath)
  ) {
    return false
  }
  let gone = scan.goneByWorktreeId.get(owner.worktreeId)
  if (!gone) {
    gone = isLocalWorktreeGone(owner.worktreeId, scan)
    scan.goneByWorktreeId.set(owner.worktreeId, gone)
  }
  return gone
}

async function isLocalWorktreeGone(
  worktreeId: string,
  scan: SessionFolderGcScan
): Promise<boolean> {
  const parsed = splitWorktreeId(worktreeId)
  const repoPath = parsed && scan.localRepoPaths.get(parsed.repoId)
  if (
    !parsed ||
    !repoPath ||
    !isProbeableLocalPath(parsed.worktreePath) ||
    worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
  ) {
    return false
  }
  // A missing repo root, or a missing or empty parent (an unmounted mount point), is not a deletion.
  const [repoReachable, parentReachable] = await Promise.all([
    cachedDirHasEntries(repoPath, scan),
    cachedDirHasEntries(dirname(parsed.worktreePath), scan)
  ])
  if (!repoReachable || !parentReachable) {
    return false
  }
  try {
    // lstat: a dangling link to an ejected volume is not a deleted worktree.
    await lstat(parsed.worktreePath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

/** Drive paths on Windows, absolute paths elsewhere; WSL and network shares can report ENOENT for live folders. */
function isProbeableLocalPath(path: string): boolean {
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/')
}

function cachedDirHasEntries(path: string, scan: SessionFolderGcScan): Promise<boolean> {
  let hasEntries = scan.dirHasEntriesByPath.get(path)
  if (!hasEntries) {
    hasEntries = dirHasEntries(path).catch(() => false)
    scan.dirHasEntriesByPath.set(path, hasEntries)
  }
  return hasEntries
}

async function dirHasEntries(path: string): Promise<boolean> {
  const dir = await opendir(path)
  try {
    return (await dir.read()) !== null
  } finally {
    await dir.close()
  }
}
