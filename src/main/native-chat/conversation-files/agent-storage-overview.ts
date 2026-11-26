import { lstat, opendir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { scanWorkspaceSpaceEntryTree } from '../../../shared/workspace-disk-space/workspace-space-entry-traversal'

type StorageTotals = {
  referencedBytes: number
  uniqueAllocatedBytes: number
  skippedEntries: number
}
export type AgentStorageOverview = {
  stateDirectory: string
  totals: StorageTotals
  entries: (StorageTotals & { name: string })[]
}

export async function inspectAgentStorage(
  stateDirectory: string,
  signal?: AbortSignal
): Promise<AgentStorageOverview> {
  const root = resolve(stateDirectory)
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('Storage overview requires a real profile directory, not a symlink')
  }
  const totalInodes = new Set<string>()
  const groupInodes = new Map<string, Set<string>>()
  const groups = new Map<string, StorageTotals>()
  let uniqueAllocatedBytes = 0
  const checkCancelled = (): void => signal?.throwIfAborted()
  const scan = await scanWorkspaceSpaceEntryTree({
    rootPath: root,
    rootName: 'profile',
    concurrency: 4,
    signal,
    entryName: (entry: { name: string }) => entry.name,
    joinPath: join,
    readDirectory: (path) => opendir(path),
    checkCancelled,
    createCancellationError: () => new Error('Storage scan cancelled'),
    isCancellationError: (error) => signal?.aborted === true || error instanceof RangeError,
    classifyEntry: async (path) => {
      const info = await lstat(path, { bigint: true })
      checkCancelled()
      const bytes = Number(typeof info.blocks === 'bigint' ? info.blocks * 512n : info.size)
      const inode = info.ino === 0n ? path : `${info.dev}:${info.ino}`
      const shared = info.nlink > 1n && !info.isDirectory() && info.ino !== 0n
      if (!shared || !totalInodes.has(inode)) {
        if (shared) {
          if (totalInodes.size >= 250_000) {
            throw new RangeError(
              'Profile has too many hardlinked files to scan safely; scan a smaller directory'
            )
          }
          totalInodes.add(inode)
        }
        uniqueAllocatedBytes += bytes
      }
      const group = relative(root, path).split(sep)[0]
      if (group) {
        let seen = groupInodes.get(group)
        if (!seen) {
          seen = new Set()
          groupInodes.set(group, seen)
          groups.set(group, { referencedBytes: 0, uniqueAllocatedBytes: 0, skippedEntries: 0 })
        }
        const totals = groups.get(group)
        if (totals) {
          totals.referencedBytes += bytes
          if (!shared || !seen.has(inode)) {
            if (shared) {
              seen.add(inode)
            }
            totals.uniqueAllocatedBytes += bytes
          }
        }
      }
      return {
        kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
        sizeBytes: bytes
      }
    }
  })
  return {
    stateDirectory: root,
    totals: {
      referencedBytes: scan.sizeBytes,
      uniqueAllocatedBytes,
      skippedEntries: scan.skippedEntryCount
    },
    entries: (scan.children ?? [])
      .map((entry) => ({
        name: entry.name,
        referencedBytes: entry.sizeBytes,
        uniqueAllocatedBytes: groups.get(entry.name)?.uniqueAllocatedBytes ?? 0,
        skippedEntries: entry.skippedEntryCount
      }))
      .sort((a, b) => b.uniqueAllocatedBytes - a.uniqueAllocatedBytes)
  }
}
