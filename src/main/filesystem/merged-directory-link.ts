import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rmdir,
  stat,
  symlink,
  unlink
} from 'node:fs/promises'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'

/** Where a folder waits while its entries move into the shared one; conflicts stay here. */
export const MERGE_PENDING_SUFFIX = '.orca-profile-merge'

export type MergedDirectoryLinkOutcome = 'linked' | 'unchanged' | 'user-owned'

export type DirectoryLinkErrorCode = 'cross-filesystem' | 'retained-conflict' | 'link-failed'

export class DirectoryLinkError extends Error {
  readonly code: DirectoryLinkErrorCode

  constructor(code: DirectoryLinkErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type MergedDirectoryLinkArgs = {
  /** The private folder that becomes a link. */
  source: string
  /** The shared folder it links to; created when missing. */
  destination: string
  platform: NodeJS.Platform
  /** Problems that leave the link published, such as retained conflicts. */
  onWarning: (error: unknown) => void
  /**
   * Runs before an entry joins `destination`, with its current path: one that moves (a folder
   * moves whole) or a hard-linked duplicate whose name is dropped.
   */
  beforeShare?: (path: string) => void | Promise<void>
  /** Empty files that collide with a shared name are dropped (lock files hold no data). */
  dropEmptyConflicts?: boolean
}

type MoveOptions = Pick<MergedDirectoryLinkArgs, 'beforeShare' | 'dropEmptyConflicts'>

export async function lstatIfPresent(file: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(file, { bigint: true })
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return undefined
  }
}

type MoveResult = { retained: number; failed: unknown[] }

const HARD_LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EXDEV'])

// A plain rename replaces an existing file (and on Windows a racing one), so files and links are
// published with calls that fail on an existing name and only then lose their old name.
async function moveEntry(from: string, to: string, item: BigIntStats): Promise<void> {
  if (item.isDirectory()) {
    // A directory rename never replaces a non-empty one.
    await renameFileWithWindowsRetryAsync(from, to)
    return
  }
  try {
    await (item.isSymbolicLink() ? symlink(await readlink(from), to) : link(from, to))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
    // Some filesystems refuse hard links; an exclusive copy publishes without replacing a name.
    if (!HARD_LINK_UNSUPPORTED.has(code) || !item.isFile()) {
      throw error
    }
    await copyFile(from, to, fsConstants.COPYFILE_EXCL)
  }
  await unlink(from)
}

// One locked entry must not prevent merging the rest.
async function moveTree(
  source: string,
  destination: string,
  result: MoveResult,
  options: MoveOptions
): Promise<void> {
  for (const name of await readdir(source)) {
    const from = join(source, name)
    const to = join(destination, name)
    try {
      const [item, existing] = await Promise.all([
        lstat(from, { bigint: true }),
        lstatIfPresent(to)
      ])
      if (!existing) {
        await options.beforeShare?.(from)
        await moveEntry(from, to, item)
      } else if (item.isDirectory() && existing.isDirectory()) {
        await moveTree(from, to, result, options)
      } else if (item.isFile() && item.dev === existing.dev && item.ino === existing.ino) {
        // A hard link to the shared file: dropping this name loses no bytes.
        await options.beforeShare?.(from)
        await unlink(from)
      } else if (options.dropEmptyConflicts && item.isFile() && item.size === 0n) {
        await unlink(from)
      } else {
        result.retained += 1
      }
    } catch (error) {
      result.failed.push(error)
    }
  }
  if ((await readdir(source)).length === 0) {
    await rmdir(source)
  }
}

async function drain(
  pending: string,
  destination: string,
  args: MergedDirectoryLinkArgs
): Promise<void> {
  const result: MoveResult = { retained: 0, failed: [] }
  await moveTree(pending, destination, result, args)
  if (result.failed.length > 0) {
    args.onWarning(result.failed[0])
  }
  if (result.retained > 0) {
    const detail = `${result.retained} conflicting entries kept in ${pending}`
    args.onWarning(new DirectoryLinkError('retained-conflict', detail))
  }
}

function crossFilesystem(): DirectoryLinkError {
  return new DirectoryLinkError('cross-filesystem', 'History stays private across filesystems')
}

/** Link `destination` in place of `source`, moving its entries there; existing names stay shared. */
export async function mergeDirectoryIntoLink(
  args: MergedDirectoryLinkArgs
): Promise<MergedDirectoryLinkOutcome> {
  const { source, destination } = args
  const pending = `${source}${MERGE_PENDING_SUFFIX}`
  await mkdir(destination, { recursive: true })
  const destinationDevice = (await stat(destination, { bigint: true })).dev
  const sameDevice = async (file: string): Promise<boolean> =>
    (await stat(file, { bigint: true })).dev === destinationDevice
  if ((await lstatIfPresent(pending))?.isDirectory()) {
    if (!(await sameDevice(pending))) {
      if (!(await lstatIfPresent(source))) {
        await renameFileWithWindowsRetryAsync(pending, source)
      }
      throw crossFilesystem()
    }
    try {
      await drain(pending, destination, args)
    } catch (error) {
      // Preserve unreadable leftovers without preventing link publication.
      args.onWarning(error)
    }
  }
  const current = await lstatIfPresent(source)
  if (current?.isSymbolicLink()) {
    return (await realpath(source)) === (await realpath(destination)) ? 'unchanged' : 'user-owned'
  }
  if (current && !current.isDirectory()) {
    return 'user-owned'
  }
  if (current) {
    if (!(await sameDevice(source))) {
      throw crossFilesystem()
    }
    if (await lstatIfPresent(pending)) {
      // Earlier conflicts wait there (sharing was turned off and on): merge straight in, then set
      // the new conflicts beside the old ones so the folder can still become a link.
      await drain(source, destination, args)
      if (await lstatIfPresent(source)) {
        await moveTree(source, pending, { retained: 0, failed: [] }, {})
      }
      if (await lstatIfPresent(source)) {
        // A name conflicting in both places: set this version aside in its own folder.
        await renameFileWithWindowsRetryAsync(
          source,
          `${source}.${Date.now()}${MERGE_PENDING_SUFFIX}`
        )
      }
    } else {
      await renameFileWithWindowsRetryAsync(source, pending)
    }
  }
  try {
    // Junctions avoid Windows symlink privilege requirements.
    await symlink(destination, source, args.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (current) {
      // Something recreated the folder mid-swap (such as a starting CLI); put its entries back.
      if (!(await lstatIfPresent(source))) {
        await renameFileWithWindowsRetryAsync(pending, source)
      } else if ((await lstatIfPresent(source))?.isDirectory()) {
        await moveTree(pending, source, { retained: 0, failed: [] }, {})
      }
    }
    throw new DirectoryLinkError('link-failed', String(error))
  }
  if (current) {
    await drain(pending, destination, args)
  }
  return 'linked'
}

/** Whether `source` is a link (or junction) that resolves to `destination`. */
export async function isLinkedDirectory(source: string, destination: string): Promise<boolean> {
  if (!(await lstatIfPresent(source))?.isSymbolicLink()) {
    return false
  }
  try {
    return (await realpath(source)) === (await realpath(destination))
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

/** Remove a link without following it; a Windows junction is removed as a directory. */
export async function removeDirectoryLink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    await rmdir(path)
  }
}
