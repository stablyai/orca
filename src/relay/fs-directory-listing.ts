import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DirectoryListingBudget } from '../shared/directory-listing-budget'
import type { DirEntry } from '../shared/filesystem-entry-types'
import { sortDirEntries } from '../shared/file-name-sort'
import { expandTilde } from './context'

export async function readRelayDirectoryBounded(
  dirPath: string,
  signal?: AbortSignal,
  options?: { followSymlinks?: boolean }
): Promise<DirEntry[]> {
  signal?.throwIfAborted()
  const root = expandTilde(dirPath)
  const budget = new DirectoryListingBudget()
  const entries: DirEntry[] = []
  for await (const entry of await opendir(root)) {
    signal?.throwIfAborted()
    budget.record(entry.name)
    const mapped = {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink()
    }
    if (mapped.isSymlink && !mapped.isDirectory && options?.followSymlinks !== false) {
      try {
        mapped.isDirectory = (await stat(join(root, entry.name))).isDirectory()
      } catch {
        // Broken links remain visible as links.
      }
    }
    entries.push(mapped)
  }
  return sortDirEntries(entries)
}
