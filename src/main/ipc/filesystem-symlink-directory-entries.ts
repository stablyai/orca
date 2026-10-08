import type { Dirent } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

export function classifyFilesystemDirectoryEntries(
  dirPath: string,
  entries: readonly Dirent[],
  followSymlinks: boolean,
  authorize: (path: string) => Promise<string>
): Promise<DirEntry[]> {
  return mapWithConcurrency(entries, 8, async (entry) => {
    const isSymlink = entry.isSymbolicLink()
    let isDirectory = !isSymlink && entry.isDirectory()
    if (isSymlink && followSymlinks) {
      try {
        isDirectory = (await stat(await authorize(join(dirPath, entry.name)))).isDirectory()
      } catch {
        // Broken or unauthorized targets remain file-like.
      }
    }
    return { name: entry.name, isDirectory, isSymlink }
  })
}
