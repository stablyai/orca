import type { DirEntry } from '../shared/filesystem-entry-types'
import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import { compactWorkspaceSpaceItems } from '../shared/workspace-space-compaction'
import { scanWorkspaceSpaceEntryTree } from '../shared/workspace-space-entry-traversal'
import type { IFilesystemProvider } from './providers/types'
import {
  WorkspaceSpaceScanCancelledError,
  classifyWorkspaceSpaceError,
  isWorkspaceSpaceAbortError,
  isWorkspaceSpaceRelayMethodMissing,
  throwIfWorkspaceSpaceScanAborted,
  type AsyncLimiter
} from './workspace-space-scan-control'
import {
  basenameWorkspaceFilesystemPath,
  createScannedWorkspaceSpaceRow,
  createUnavailableWorkspaceSpaceRow,
  joinWorkspaceFilesystemPath,
  toWorkspaceSpaceItem
} from './workspace-space-worktree-row'

const REMOTE_FS_CONCURRENCY = 10

async function scanRemoteEntry(
  entryPath: string,
  name: string,
  provider: IFilesystemProvider,
  signal?: AbortSignal
) {
  return scanWorkspaceSpaceEntryTree<DirEntry>({
    rootPath: entryPath,
    rootName: name,
    concurrency: REMOTE_FS_CONCURRENCY,
    signal,
    entryName: (entry) => entry.name,
    joinPath: joinWorkspaceFilesystemPath,
    classifyEntry: async (path, sourceEntry) => {
      if (sourceEntry?.isSymlink) {
        return { kind: 'symlink', sizeBytes: 0 }
      }
      const stats = await provider.stat(path)
      throwIfWorkspaceSpaceScanAborted(signal)
      if (stats.type === 'symlink') {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.type === 'directory'
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => provider.readDir(path),
    checkCancelled: () => throwIfWorkspaceSpaceScanAborted(signal),
    createCancellationError: () => new WorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof WorkspaceSpaceScanCancelledError
  })
}

export async function scanRemoteWorkspaceSpaceWorktree(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  provider: IFilesystemProvider,
  fallbackTraversalLimit: AsyncLimiter,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  try {
    if (provider.scanWorkspaceSpace) {
      try {
        const scan = await provider.scanWorkspaceSpace(worktree.path, { signal })
        return createScannedWorkspaceSpaceRow(repo, worktree, scannedAt, scan)
      } catch (error) {
        if (isWorkspaceSpaceAbortError(error)) {
          throw new WorkspaceSpaceScanCancelledError()
        }
        if (!isWorkspaceSpaceRelayMethodMissing(error)) {
          throw error
        }
      }
    }
    const root = await fallbackTraversalLimit(() =>
      scanRemoteEntry(
        worktree.path,
        basenameWorkspaceFilesystemPath(worktree.path),
        provider,
        signal
      )
    )
    return createScannedWorkspaceSpaceRow(repo, worktree, scannedAt, {
      sizeBytes: root.sizeBytes,
      skippedEntryCount: root.skippedEntryCount,
      ...compactWorkspaceSpaceItems((root.children ?? []).map(toWorkspaceSpaceItem))
    })
  } catch (error) {
    if (error instanceof WorkspaceSpaceScanCancelledError) {
      throw error
    }
    const classified = classifyWorkspaceSpaceError(error)
    return createUnavailableWorkspaceSpaceRow(
      repo,
      worktree,
      scannedAt,
      classified.status,
      classified.message
    )
  }
}
