import { opendir } from 'node:fs/promises'
import type { DirEntry } from '../../shared/types'
import {
  createFilesystemDirectoryLimitState,
  trackFilesystemDirectoryEntry,
  type FilesystemDirectoryListingLimits
} from '../../shared/filesystem-directory-listing-limit'

type LocalDirectorySourceEntry = {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export async function readLocalFilesystemDirectory(dirPath: string): Promise<DirEntry[]> {
  return collectLocalFilesystemDirectoryEntries(await opendir(dirPath))
}

export async function collectLocalFilesystemDirectoryEntries(
  directory: AsyncIterable<LocalDirectorySourceEntry> | Iterable<LocalDirectorySourceEntry>,
  requestedLimits?: Partial<FilesystemDirectoryListingLimits>
): Promise<DirEntry[]> {
  const entries: DirEntry[] = []
  const limit = createFilesystemDirectoryLimitState(requestedLimits)
  for await (const entry of directory) {
    trackFilesystemDirectoryEntry(limit, entry)
    const isSymlink = entry.isSymbolicLink()
    entries.push({
      name: entry.name,
      // Why: avoid probing macOS TCC-protected symlink targets during listing.
      isDirectory: !isSymlink && entry.isDirectory(),
      isSymlink
    })
  }
  return entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}
