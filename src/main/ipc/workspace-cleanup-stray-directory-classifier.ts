import { lstat, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveGitMetadataPath } from '../../shared/git-metadata-path'
import {
  WORKSPACE_CLEANUP_STRAY_DIRECTORY_MIN_AGE_MS,
  type WorkspaceCleanupStrayDirectory
} from '../../shared/workspace-cleanup-stray-directories'
import { isENOENT } from './filesystem-path-containment'

// A real `.git` pointer file is one short line; anything larger is not one.
const GIT_POINTER_MAX_BYTES = 4096

/** Paths that must never read as stray, already normalized for comparison. */
export type WorkspaceCleanupStrayGuard = {
  /** Registered worktrees of every listed project, plus every project checkout. */
  ownedPathKeys: ReadonlySet<string>
  /** Checkouts a background removal is deleting or failed to delete; that row owns them. */
  removalPathKeys: ReadonlySet<string>
}

export type WorkspaceCleanupStrayVerdict =
  | { stray: true; gitLink: WorkspaceCleanupStrayDirectory['gitLink']; lastModifiedAt: number }
  | { stray: false; why: string }

export function toWorkspaceCleanupStrayPathKey(value: string): string {
  return normalizeRuntimePathForComparison(path.resolve(value))
}

/**
 * Decides whether one folder directly inside a worktree root is an unregistered leftover.
 *
 * Never descends: the only reads are the folder itself and its own `.git` entry. A `.git`
 * directory is a repository, and a `.git` file whose Git folder still exists is a live checkout
 * of some repository Orca may not know; both are refused. Only a pointer whose target is gone, or
 * no `.git` at all, can be stray.
 */
export async function classifyWorkspaceCleanupStrayDirectory(
  directoryPath: string,
  guard: WorkspaceCleanupStrayGuard,
  scannedAt: number
): Promise<WorkspaceCleanupStrayVerdict> {
  const key = toWorkspaceCleanupStrayPathKey(directoryPath)
  if (guard.ownedPathKeys.has(key) || guard.removalPathKeys.has(key)) {
    return { stray: false, why: 'registered' }
  }
  const keyWithBoundary = `${key.replace(/\/+$/, '')}/`
  for (const owned of guard.ownedPathKeys) {
    if (owned.startsWith(keyWithBoundary)) {
      return { stray: false, why: 'holds-registered-path' }
    }
  }
  const entry = await lstat(directoryPath).catch(() => null)
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
    return { stray: false, why: 'not-a-directory' }
  }
  const gitPath = path.join(directoryPath, '.git')
  const gitEntry = await lstat(gitPath).catch((error: unknown) =>
    isENOENT(error) ? null : undefined
  )
  if (gitEntry === undefined) {
    return { stray: false, why: 'unreadable-git-entry' }
  }
  let gitLink: WorkspaceCleanupStrayDirectory['gitLink'] = 'none'
  if (gitEntry) {
    if (!gitEntry.isFile()) {
      return { stray: false, why: 'repository' }
    }
    if (!(await isGitPointerTargetMissing(directoryPath, gitPath))) {
      return { stray: false, why: 'linked-checkout' }
    }
    gitLink = 'missing-gitdir'
  }
  const lastModifiedAt = Math.max(entry.mtimeMs, gitEntry?.mtimeMs ?? 0)
  if (scannedAt - lastModifiedAt < WORKSPACE_CLEANUP_STRAY_DIRECTORY_MIN_AGE_MS) {
    return { stray: false, why: 'recent' }
  }
  return { stray: true, gitLink, lastModifiedAt }
}

/** True only when the pointer parses and its target is provably absent. */
async function isGitPointerTargetMissing(directoryPath: string, gitPath: string): Promise<boolean> {
  let contents: string
  try {
    const handle = await open(gitPath, 'r')
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(GIT_POINTER_MAX_BYTES),
        position: 0
      })
      contents = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
  const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(contents)?.[1]
  const gitDir = pointer ? resolveGitMetadataPath(directoryPath, pointer) : null
  if (!gitDir) {
    return false
  }
  try {
    await stat(gitDir)
    return false
  } catch (error) {
    return isENOENT(error)
  }
}
