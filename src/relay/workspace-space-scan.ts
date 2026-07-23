/* eslint-disable max-lines -- Why: local and relay Space scans share the same
   cancellation, symlink, and top-level compaction semantics in one scanner. */
import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { platform } from 'node:process'
import { promisify } from 'node:util'
import type {
  WorkspaceSpaceDirectoryScanResult,
  WorkspaceSpaceItem
} from '../shared/workspace-space-types'
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
import type { RequestContext } from './dispatcher'

const RELAY_FS_CONCURRENCY = 48
const DU_TIMEOUT_MS = 120_000
const DU_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const execFileAsync = promisify(execFile)

type ScanStats = WorkspaceSpaceEntryScan

class RelayWorkspaceSpaceScanCancelledError extends Error {
  constructor() {
    super('Workspace space scan cancelled')
    this.name = 'RelayWorkspaceSpaceScanCancelledError'
  }
}

function throwIfCancelled(context: RequestContext): void {
  if (context.isStale() || context.signal?.aborted) {
    throw new RelayWorkspaceSpaceScanCancelledError()
  }
}

function normalizeDuPath(pathValue: string): string {
  const trimmed = pathValue.replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : pathValue
}

function parseDuDepthOneOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalizedLine) {
      continue
    }
    const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
    if (!match) {
      continue
    }
    sizes.set(normalizeDuPath(match[2]), Number(match[1]) * 1024)
  }
  return sizes
}

async function readDuDepthOne(
  rootPath: string,
  context: RequestContext
): Promise<Map<string, number>> {
  throwIfCancelled(context)
  const { stdout } = await execFileAsync('du', ['-k', '-d', '1', rootPath], {
    encoding: 'utf8',
    maxBuffer: DU_MAX_BUFFER_BYTES,
    signal: context.signal,
    timeout: DU_TIMEOUT_MS
  })
  throwIfCancelled(context)
  return parseDuDepthOneOutput(stdout)
}

function toWorkspaceSpaceItem(stats: ScanStats): WorkspaceSpaceItem {
  return {
    name: stats.name,
    path: stats.path,
    kind: stats.kind,
    sizeBytes: stats.sizeBytes
  }
}

async function scanTopLevelEntryWithDu(
  entryPath: string,
  name: string,
  duSizes: Map<string, number>,
  context: RequestContext
): Promise<ScanStats> {
  throwIfCancelled(context)
  const stats = await lstat(entryPath)
  throwIfCancelled(context)

  if (stats.isSymbolicLink()) {
    return {
      name,
      path: entryPath,
      kind: 'symlink',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  if (!stats.isDirectory()) {
    return {
      name,
      path: entryPath,
      kind: 'file',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  return {
    name,
    path: entryPath,
    kind: 'directory',
    sizeBytes: duSizes.get(normalizeDuPath(entryPath)) ?? stats.size,
    skippedEntryCount: 0
  }
}

async function scanEntryAggregate(
  entryPath: string,
  name: string,
  context: RequestContext
): Promise<ScanStats> {
  return scanWorkspaceSpaceEntryTree<Dirent>({
    rootPath: entryPath,
    rootName: name,
    concurrency: RELAY_FS_CONCURRENCY,
    signal: context.signal,
    entryName: (entry) => entry.name,
    joinPath: join,
    classifyEntry: async (path) => {
      const stats = await lstat(path)
      throwIfCancelled(context)
      if (stats.isSymbolicLink()) {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.isDirectory()
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => opendir(path),
    checkCancelled: () => throwIfCancelled(context),
    createCancellationError: () => new RelayWorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof RelayWorkspaceSpaceScanCancelledError
  })
}

async function scanDirectoryWithDu(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  throwIfCancelled(context)
  const rootStats = await lstat(rootPath)
  throwIfCancelled(context)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return scanDirectoryWithNode(rootPath, context)
  }

  const [entries, duSizes] = await Promise.all([
    opendir(rootPath).then((directory) =>
      collectWorkspaceSpaceDirectoryEntries(
        directory,
        rootPath,
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget(),
        () => throwIfCancelled(context)
      )
    ),
    readDuDepthOne(rootPath, context)
  ])
  throwIfCancelled(context)
  const childStats = await mapWithConcurrency(
    entries,
    RELAY_FS_CONCURRENCY,
    async (entry): Promise<ScanStats | null> => {
      try {
        return await scanTopLevelEntryWithDu(
          join(rootPath, entry.name),
          entry.name,
          duSizes,
          context
        )
      } catch (error) {
        if (error instanceof RelayWorkspaceSpaceScanCancelledError) {
          throw error
        }
        return null
      }
    }
  )
  const children = childStats.filter((child): child is ScanStats => child !== null)
  const compact = compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))

  return {
    sizeBytes:
      duSizes.get(normalizeDuPath(rootPath)) ??
      rootStats.size + children.reduce((sum, child) => sum + child.sizeBytes, 0),
    skippedEntryCount: childStats.length - children.length,
    ...compact
  }
}

async function scanDirectoryWithNode(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  const root = await scanEntryAggregate(rootPath, basename(rootPath), context)
  const children = root.children ?? []
  const compact = compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))

  return {
    sizeBytes: root.sizeBytes,
    skippedEntryCount: root.skippedEntryCount,
    ...compact
  }
}

export async function scanWorkspaceSpaceDirectory(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  if (platform !== 'win32') {
    try {
      return await scanDirectoryWithDu(rootPath, context)
    } catch (error) {
      if (
        error instanceof RelayWorkspaceSpaceScanCancelledError ||
        error instanceof WorkspaceSpaceScanCapacityError
      ) {
        throw error
      }
    }
  }
  return scanDirectoryWithNode(rootPath, context)
}
