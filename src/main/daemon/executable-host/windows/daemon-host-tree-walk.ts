import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrencyUntilFailure } from '../../../../shared/concurrency/map-with-concurrency'

export type TreeEntry = {
  sourcePath: string
  /** Destination path relative to the host root, posix-separated. */
  destRel: string
  /** Return false to exclude a path; children inherit their root's filter. */
  filter?: (sourcePath: string) => boolean
}

export type TreeListing = { files: TreeEntry[]; dirs: TreeEntry[] }

function accepted(entry: TreeEntry): boolean {
  return !entry.filter || entry.filter(entry.sourcePath)
}

/** Breadth-first so one limit bounds every pending stat and readdir across the whole tree. */
export async function listDaemonHostTree(
  roots: readonly TreeEntry[],
  limit: number
): Promise<TreeListing> {
  const listing: TreeListing = { files: [], dirs: [] }
  let level = roots.filter(accepted)
  while (level.length > 0) {
    // Follow links (stat, not lstat) so the mirror survives removal of the install directory.
    const isDir = await mapWithConcurrencyUntilFailure(level, limit, async (entry) =>
      (await stat(entry.sourcePath)).isDirectory()
    )
    const dirs = level.filter((_, index) => isDir[index])
    listing.dirs.push(...dirs)
    listing.files.push(...level.filter((_, index) => !isDir[index]))
    const children = await mapWithConcurrencyUntilFailure(dirs, limit, async (dir) =>
      (await readdir(dir.sourcePath)).map((name) => ({
        sourcePath: join(dir.sourcePath, name),
        destRel: `${dir.destRel}/${name}`,
        filter: dir.filter
      }))
    )
    level = children.flat().filter(accepted)
  }
  return listing
}
