import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createFilesystemDirectoryLimitState,
  trackFilesystemDirectoryEntry,
  type FilesystemDirectoryListingLimits
} from '../shared/filesystem-directory-listing-limit'

type RelayDirectorySourceEntry = {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type RelayFilesystemDirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

type DirectoryClassifier = (dirPath: string, entry: RelayDirectorySourceEntry) => Promise<boolean>

async function isRelayFilesystemDirectoryEntry(
  dirPath: string,
  entry: RelayDirectorySourceEntry
): Promise<boolean> {
  if (entry.isDirectory()) {
    return true
  }
  if (!entry.isSymbolicLink()) {
    return false
  }
  try {
    // Why: linked directories must remain expandable remotely.
    return (await stat(join(dirPath, entry.name))).isDirectory()
  } catch {
    return false
  }
}

export async function readRelayFilesystemDirectory(
  dirPath: string,
  requestedLimits?: Partial<FilesystemDirectoryListingLimits>
): Promise<RelayFilesystemDirectoryEntry[]> {
  return collectRelayFilesystemDirectoryEntries(dirPath, await opendir(dirPath), requestedLimits)
}

export async function collectRelayFilesystemDirectoryEntries(
  dirPath: string,
  directory: AsyncIterable<RelayDirectorySourceEntry> | Iterable<RelayDirectorySourceEntry>,
  requestedLimits?: Partial<FilesystemDirectoryListingLimits>,
  classifyDirectory: DirectoryClassifier = isRelayFilesystemDirectoryEntry
): Promise<RelayFilesystemDirectoryEntry[]> {
  const entries: RelayFilesystemDirectoryEntry[] = []
  const limit = createFilesystemDirectoryLimitState(requestedLimits)
  for await (const entry of directory) {
    trackFilesystemDirectoryEntry(limit, entry)
    entries.push({
      name: entry.name,
      isDirectory: await classifyDirectory(dirPath, entry),
      isSymlink: entry.isSymbolicLink()
    })
  }
  return entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}
