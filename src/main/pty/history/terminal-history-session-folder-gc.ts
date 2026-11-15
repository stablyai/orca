// Daemon session folders record no owner in meta.json; their name is the session id, which embeds the worktree id.

import { stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { isTerminalHistorySessionDirRecoveryProtected } from '../../daemon/history/storage/terminal-history-recovery-quarantine'

export type SessionFolderGcOwners = {
  /** Repos only this machine hosts; only their worktrees can be proven gone by a local stat. */
  localRepoPaths: ReadonlyMap<string, string>
  /** Every daemon session still running, whatever its worktree. */
  liveSessionIds: ReadonlySet<string>
}

export type SessionFolderGcScan = SessionFolderGcOwners & {
  liveWorktreeIds: ReadonlySet<string>
  goneByWorktreeId: Map<string, Promise<boolean>>
  dirExistsByPath: Map<string, Promise<boolean>>
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
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repoPath = parsed && scan.localRepoPaths.get(parsed.repoId)
  // A path this OS cannot address (e.g. a POSIX path on Windows) proves nothing.
  if (!parsed || !repoPath || !isAbsolute(parsed.worktreePath)) {
    return false
  }
  // A missing repo root or parent folder means an unmounted or unreachable volume, not a deletion.
  const [repoReachable, parentReachable] = await Promise.all([
    cachedDirExists(repoPath, scan),
    cachedDirExists(dirname(parsed.worktreePath), scan)
  ])
  if (!repoReachable || !parentReachable) {
    return false
  }
  try {
    await stat(parsed.worktreePath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

function cachedDirExists(path: string, scan: SessionFolderGcScan): Promise<boolean> {
  let exists = scan.dirExistsByPath.get(path)
  if (!exists) {
    exists = stat(path).then(
      (info) => info.isDirectory(),
      () => false
    )
    scan.dirExistsByPath.set(path, exists)
  }
  return exists
}
