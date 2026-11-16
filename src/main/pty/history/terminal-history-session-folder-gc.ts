// Daemon session folders record no owner in meta.json; their name is the session id, which embeds the worktree id.

import { lstat, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../../../shared/worktree/id'
import { isTerminalHistorySessionDirRecoveryProtected } from '../../daemon/history/storage/terminal-history-recovery-quarantine'

export type SessionFolderGcOwners = {
  /** Repos only this machine hosts; only their worktrees can be proven gone by a local stat. */
  localRepoPaths: ReadonlyMap<string, string>
  /** Every daemon session still running, whatever its worktree. */
  liveSessionIds: ReadonlySet<string>
  /** The candidates' session ids that a saved session on any host still references. */
  referencedSessionIds: (
    candidates: readonly { sessionId: string; worktreeId: string }[]
  ) => ReadonlySet<string>
}

export type SessionFolderGcScan = SessionFolderGcOwners & {
  liveWorktreeIds: ReadonlySet<string>
  goneByWorktreeId: Map<string, Promise<boolean>>
  /** The known sibling that proved each parent's volume mounted, or null when none did. */
  mountProofByParentKey: Map<string, Promise<string | null>>
  knownPathsByParentKey?: Map<string, string[]>
  candidates: { root: string; entryPath: string; sessionId: string; worktreeId: string }[]
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

/** A recheck just before deletion, in case a volume detached during the scan. */
export function createStillGoneCheck(
  scan: SessionFolderGcScan
): (worktreeId: string) => Promise<boolean> {
  const fresh = { ...scan, mountProofByParentKey: new Map<string, Promise<string | null>>() }
  return (worktreeId) => isLocalWorktreeGone(worktreeId, fresh)
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
  // Only a known worktree present beside it proves the volume is mounted; a bare mount point can hold files.
  const [repoReachable, volumeReachable] = await Promise.all([
    isDirectory(repoPath),
    cachedKnownSiblingPresent(parsed.worktreePath, scan)
  ])
  if (!repoReachable || !volumeReachable) {
    return false
  }
  try {
    // lstat: a dangling link to an ejected volume is not a deleted worktree.
    await lstat(parsed.worktreePath)
    return false
  } catch (error) {
    return errnoCodeOrUnknown(error) === 'ENOENT'
  }
}

/** Drive paths on Windows, absolute paths elsewhere; WSL and network shares can report ENOENT for live folders. */
function isProbeableLocalPath(path: string): boolean {
  return process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/')
}

async function cachedKnownSiblingPresent(
  worktreePath: string,
  scan: SessionFolderGcScan
): Promise<boolean> {
  // No case folding: on a case-sensitive volume a differently-cased parent is another folder.
  const parentKey = resolve(dirname(worktreePath))
  let proof = scan.mountProofByParentKey.get(parentKey)
  if (!proof) {
    proof = findRealSibling(knownPathsByParentKey(scan).get(parentKey) ?? [])
    scan.mountProofByParentKey.set(parentKey, proof)
  }
  // Re-probe the proving sibling every call: one lstat keeps the proof current without rescanning siblings.
  const sibling = await proof
  return sibling !== null && (await isRealDirectory(sibling))
}

/** lstat: a symlinked sibling can point at another, still-mounted volume. */
async function findRealSibling(siblings: readonly string[]): Promise<string | null> {
  const found = await Promise.all(siblings.map(isRealDirectory))
  return siblings[found.indexOf(true)] ?? null
}

function knownPathsByParentKey(scan: SessionFolderGcScan): Map<string, string[]> {
  if (!scan.knownPathsByParentKey) {
    const byParent = new Map<string, string[]>()
    const known = [...scan.localRepoPaths.values()]
    for (const worktreeId of scan.liveWorktreeIds) {
      const path = splitWorktreeId(worktreeId)?.worktreePath
      if (
        path &&
        isProbeableLocalPath(path) &&
        !path.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
      ) {
        known.push(path)
      }
    }
    for (const path of known) {
      const key = resolve(dirname(path))
      const siblings = byParent.get(key)
      if (siblings) {
        siblings.push(path)
      } else {
        byParent.set(key, [path])
      }
    }
    scan.knownPathsByParentKey = byParent
  }
  return scan.knownPathsByParentKey
}

function isRealDirectory(path: string): Promise<boolean> {
  return lstat(path).then(
    (info) => info.isDirectory(),
    () => false
  )
}

function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false
  )
}
