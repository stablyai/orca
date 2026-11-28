import { chmod, lstat, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrencyUntilFailure } from '../../../../shared/concurrency/map-with-concurrency'

// Staging runs during app startup; two ops in flight leave libuv's 4-thread pool to startup I/O.
export const DAEMON_HOST_FS_CONCURRENCY = 2

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
  limit: number,
  { followLinks = true }: { followLinks?: boolean } = {}
): Promise<TreeListing> {
  const listing: TreeListing = { files: [], dirs: [] }
  let level = roots.filter(accepted)
  while (level.length > 0) {
    // Copies follow links so the mirror survives removal of the install directory; removal never does.
    const isDir = await mapWithConcurrencyUntilFailure(level, limit, async (entry) =>
      (await (followLinks ? stat : lstat)(entry.sourcePath)).isDirectory()
    )
    listing.files.push(...level.filter((_, index) => !isDir[index]))
    const children = await mapWithConcurrencyUntilFailure(
      level.filter((_, index) => isDir[index]),
      limit,
      async (dir) => {
        // Removal re-checks before descending so a dir swapped for a junction is unlinked, not walked.
        // A swap between this lstat and readdir stays possible; it needs a same-user writer in the tree.
        if (!followLinks && !(await lstat(dir.sourcePath)).isDirectory()) {
          listing.files.push(dir)
          return []
        }
        listing.dirs.push(dir)
        return (await readdir(dir.sourcePath)).map((name) => ({
          sourcePath: join(dir.sourcePath, name),
          destRel: `${dir.destRel}/${name}`,
          filter: dir.filter
        }))
      }
    )
    level = children.flat().filter(accepted)
  }
  return listing
}

// Windows refuses unlink on a directory junction (rmdir removes the link, not its target) and on a
// read-only file, which copyFile keeps from a read-only install; rmSync cleared that flag, so do too.
async function removeStubbornEntry(path: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) {
    await rmdir(path)
    return
  }
  await chmod(path, 0o666)
  await unlink(path)
}

/** Delete a tree under the same bound; recursive fs.promises.rm has no limit on in-flight ops. */
export async function removeDaemonHostTree(root: string): Promise<void> {
  const { files, dirs } = await listDaemonHostTree(
    [{ sourcePath: root, destRel: '' }],
    DAEMON_HOST_FS_CONCURRENCY,
    { followLinks: false }
  )
  await mapWithConcurrencyUntilFailure(files, DAEMON_HOST_FS_CONCURRENCY, (file) =>
    unlink(file.sourcePath).catch(() => removeStubbornEntry(file.sourcePath))
  )
  // Breadth-first order reversed removes children before their parents.
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    await rmdir(dirs[index].sourcePath)
  }
}
