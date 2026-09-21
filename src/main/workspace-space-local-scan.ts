import { lstat, opendir } from 'node:fs/promises'
import { platform } from 'node:process'
import type { Dirent } from 'node:fs'
import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import { compactWorkspaceSpaceItems } from '../shared/workspace-space-compaction'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import {
  scanWorkspaceSpaceEntryTree,
  type WorkspaceSpaceEntryScan
} from '../shared/workspace-space-entry-traversal'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  WorkspaceSpaceScanCapacityError
} from '../shared/workspace-space-scan-budget'
import {
  WorkspaceSpaceScanCancelledError,
  classifyWorkspaceSpaceError,
  throwIfWorkspaceSpaceScanAborted
} from './workspace-space-scan-control'
import {
  basenameWorkspaceFilesystemPath,
  createScannedWorkspaceSpaceRow,
  createUnavailableWorkspaceSpaceRow,
  joinWorkspaceFilesystemPath,
  toWorkspaceSpaceItem
} from './workspace-space-worktree-row'

const LOCAL_FS_CONCURRENCY = 48

export type ReadLocalDuDepthOne = (
  rootPath: string,
  signal?: AbortSignal
) => Promise<Map<string, number>>

async function scanLocalEntry(
  entryPath: string,
  name: string,
  signal?: AbortSignal
): Promise<WorkspaceSpaceEntryScan> {
  return scanWorkspaceSpaceEntryTree<Dirent>({
    rootPath: entryPath,
    rootName: name,
    concurrency: LOCAL_FS_CONCURRENCY,
    signal,
    entryName: (entry) => entry.name,
    joinPath: joinWorkspaceFilesystemPath,
    classifyEntry: async (path) => {
      const stats = await lstat(path)
      throwIfWorkspaceSpaceScanAborted(signal)
      if (stats.isSymbolicLink()) {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.isDirectory()
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => opendir(path),
    checkCancelled: () => throwIfWorkspaceSpaceScanAborted(signal),
    createCancellationError: () => new WorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof WorkspaceSpaceScanCancelledError
  })
}

async function scanLocalTopLevelEntry(
  entryPath: string,
  name: string,
  duSizes: Map<string, number>,
  normalizeDuPath: (path: string) => string,
  signal?: AbortSignal
): Promise<WorkspaceSpaceEntryScan> {
  throwIfWorkspaceSpaceScanAborted(signal)
  const stats = await lstat(entryPath)
  throwIfWorkspaceSpaceScanAborted(signal)
  if (stats.isSymbolicLink()) {
    return { name, path: entryPath, kind: 'symlink', sizeBytes: stats.size, skippedEntryCount: 0 }
  }
  if (!stats.isDirectory()) {
    return { name, path: entryPath, kind: 'file', sizeBytes: stats.size, skippedEntryCount: 0 }
  }
  return {
    name,
    path: entryPath,
    kind: 'directory',
    sizeBytes: duSizes.get(normalizeDuPath(entryPath)) ?? stats.size,
    skippedEntryCount: 0
  }
}

async function scanLocalWorktreeWithDu(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  readDu: ReadLocalDuDepthOne,
  normalizeDuPath: (path: string) => string,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  throwIfWorkspaceSpaceScanAborted(signal)
  const rootStats = await lstat(worktree.path)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    const root = await scanLocalEntry(
      worktree.path,
      basenameWorkspaceFilesystemPath(worktree.path),
      signal
    )
    const compact = compactWorkspaceSpaceItems((root.children ?? []).map(toWorkspaceSpaceItem))
    return createScannedWorkspaceSpaceRow(repo, worktree, scannedAt, {
      sizeBytes: root.sizeBytes,
      skippedEntryCount: root.skippedEntryCount,
      ...compact
    })
  }
  const [entries, duSizes] = await Promise.all([
    opendir(worktree.path).then(async (directory) => {
      const admission = await collectWorkspaceSpaceDirectoryEntries(
        directory,
        worktree.path,
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget(),
        () => throwIfWorkspaceSpaceScanAborted(signal)
      )
      return admission.entries
    }),
    readDu(worktree.path, signal)
  ])
  throwIfWorkspaceSpaceScanAborted(signal)
  const childStats = await mapWithConcurrency(entries, LOCAL_FS_CONCURRENCY, async (entry) => {
    try {
      return await scanLocalTopLevelEntry(
        joinWorkspaceFilesystemPath(worktree.path, entry.name),
        entry.name,
        duSizes,
        normalizeDuPath,
        signal
      )
    } catch (error) {
      if (error instanceof WorkspaceSpaceScanCancelledError) {
        throw error
      }
      return null
    }
  })
  const children = childStats.filter((child): child is WorkspaceSpaceEntryScan => child !== null)
  const rootSize =
    duSizes.get(normalizeDuPath(worktree.path)) ??
    rootStats.size + children.reduce((sum, child) => sum + child.sizeBytes, 0)
  return createScannedWorkspaceSpaceRow(repo, worktree, scannedAt, {
    sizeBytes: rootSize,
    skippedEntryCount: childStats.length - children.length,
    ...compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))
  })
}

async function scanLocalWorktreeWithNode(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  try {
    const root = await scanLocalEntry(
      worktree.path,
      basenameWorkspaceFilesystemPath(worktree.path),
      signal
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

export async function scanLocalWorkspaceSpaceWorktree(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  readDu: ReadLocalDuDepthOne,
  normalizeDuPath: (path: string) => string,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  throwIfWorkspaceSpaceScanAborted(signal)
  if (platform !== 'win32') {
    try {
      return await scanLocalWorktreeWithDu(
        repo,
        worktree,
        scannedAt,
        readDu,
        normalizeDuPath,
        signal
      )
    } catch (error) {
      throwIfWorkspaceSpaceScanAborted(signal)
      if (error instanceof WorkspaceSpaceScanCancelledError) {
        throw error
      }
      if (error instanceof WorkspaceSpaceScanCapacityError) {
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
  }
  return scanLocalWorktreeWithNode(repo, worktree, scannedAt, signal)
}
