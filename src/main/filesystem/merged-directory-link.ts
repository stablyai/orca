import {
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
import type { BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'

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
  /** Where a file joining `destination` at `to` waits instead; null shares it. */
  setAsidePath?: (from: string, to: string) => Promise<string | null>
  /** False merges a folder file by file, so `setAsidePath` sees each one. */
  movesWhole?: (folder: string) => Promise<boolean>
  /** The order a folder's entries move in. */
  entryOrder?: (left: string, right: string) => number
}

type MoveOptions = Pick<
  MergedDirectoryLinkArgs,
  'beforeShare' | 'dropEmptyConflicts' | 'setAsidePath' | 'movesWhole' | 'entryOrder'
>

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

// Never replaces a file already set aside, so a name kept there keeps waiting in the pending folder.
async function setAside(from: string, aside: string, item: BigIntStats): Promise<boolean> {
  await mkdir(dirname(aside), { recursive: true })
  try {
    return await moveEntry(from, aside, item)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

const HARD_LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EXDEV'])

// A plain rename replaces an existing file (and on Windows a racing one), and a copy would detach
// a live writer's handle, so a file moves only by a new name for its inode; false keeps it in place.
async function moveEntry(from: string, to: string, item: BigIntStats): Promise<boolean> {
  if (item.isDirectory()) {
    // A directory rename never replaces a non-empty one.
    await renameFileWithWindowsRetryAsync(from, to)
    return true
  }
  try {
    await (item.isSymbolicLink() ? symlink(await readlink(from), to) : link(from, to))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
    if (HARD_LINK_UNSUPPORTED.has(code) && item.isFile()) {
      return false
    }
    throw error
  }
  await unlink(from)
  return true
}

// One locked entry must not prevent merging the rest.
async function moveTree(
  source: string,
  destination: string,
  result: MoveResult,
  options: MoveOptions
): Promise<void> {
  for (const name of (await readdir(source)).sort(options.entryOrder)) {
    const from = join(source, name)
    const to = join(destination, name)
    try {
      const [item, existing] = await Promise.all([
        lstat(from, { bigint: true }),
        lstatIfPresent(to)
      ])
      const aside = !existing && item.isFile() ? await options.setAsidePath?.(from, to) : null
      if (aside) {
        if (!(await setAside(from, aside, item))) {
          result.retained += 1
        }
      } else if (
        !existing &&
        item.isDirectory() &&
        options.movesWhole &&
        !(await options.movesWhole(from))
      ) {
        await mkdir(to, { recursive: true })
        await moveTree(from, to, result, options)
      } else if (!existing) {
        await options.beforeShare?.(from)
        try {
          if (!(await moveEntry(from, to, item))) {
            result.retained += 1
          }
        } catch (error) {
          // Another merge into the same destination created this folder first: merge into it.
          if (!item.isDirectory() || !(await lstatIfPresent(to))?.isDirectory()) {
            throw error
          }
          await moveTree(from, to, result, options)
        }
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
