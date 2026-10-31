import { lstat, opendir } from 'node:fs/promises'
import { platform } from 'node:process'
import type { Dirent } from 'node:fs'
import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import { compactWorkspaceSpaceItems } from '../shared/workspace-space-compaction'
import { escapeRegex } from '../shared/string-utils'
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

function normalizeDuPath(pathValue: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const trimmed = pathValue.replace(new RegExp(`${escapeRegex(separator)}+$`), '')
  return trimmed.length > 0 ? trimmed : pathValue
}

function parseDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
    const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
    if (match) {
      sizes.set(normalizeDuPath(match[2]), Number(match[1]) * 1024)
    }
  }
  return sizes
}

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
  duSizes: Map<string, number>,
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
  const directory = await opendir(worktree.path)
  const admission = await collectWorkspaceSpaceDirectoryEntries(
    directory,
    worktree.path,
    (entry) => entry.name,
    createWorkspaceSpaceScanBudget(),
    () => throwIfWorkspaceSpaceScanAborted(signal)
  )
  const entries = admission.entries
  throwIfWorkspaceSpaceScanAborted(signal)
  const childStats = await mapWithConcurrency(entries, LOCAL_FS_CONCURRENCY, async (entry) => {
    try {
      return await scanLocalTopLevelEntry(
        joinWorkspaceFilesystemPath(worktree.path, entry.name),
        entry.name,
        duSizes,
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
  duOutput: string | null,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  throwIfWorkspaceSpaceScanAborted(signal)
  if (platform !== 'win32' && duOutput !== null) {
    try {
      return await scanLocalWorktreeWithDu(
        repo,
        worktree,
        scannedAt,
        parseDuOutput(duOutput),
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
