import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FOLDER_ARCHIVE_DEFAULT_EXCLUDED_NAMES,
  FOLDER_ARCHIVE_MAX_ENTRIES,
  FOLDER_ARCHIVE_MAX_TOTAL_BYTES
} from '../../../../shared/rpc-contract/files-archive-params'

export type FolderArchiveEntry = {
  /** Path inside the archive, `/`-separated, prefixed by the archived folder's name. */
  archivePath: string
  absolutePath: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  mode: number
  mtimeMs: number
}

export type FolderArchivePlan = {
  entries: FolderArchiveEntry[]
  fileCount: number
  directoryCount: number
  totalBytes: number
  excludedDirCount: number
}

export class FolderArchiveLimitError extends Error {
  constructor(readonly code: 'archive_too_large' | 'archive_too_many_entries') {
    super(code)
    this.name = 'FolderArchiveLimitError'
  }
}

export type FolderArchiveWalkOptions = {
  excludeDefaultDirs: boolean
  maxTotalBytes?: number
  maxEntries?: number
  signal?: AbortSignal
}

/**
 * Lists a folder for archiving without ever following a symlink, so every entry stays under
 * the root's real path. A directory swapped for a link mid-walk fails its realpath check and is skipped.
 */
export async function planFolderArchive(
  rootPath: string,
  archiveRootName: string,
  options: FolderArchiveWalkOptions
): Promise<FolderArchivePlan> {
  // Child realpath checks compare against this, so the root itself must be canonical.
  const rootRealPath = await realpath(rootPath)
  const maxTotalBytes = options.maxTotalBytes ?? FOLDER_ARCHIVE_MAX_TOTAL_BYTES
  const maxEntries = options.maxEntries ?? FOLDER_ARCHIVE_MAX_ENTRIES
  const excluded = new Set<string>(
    options.excludeDefaultDirs ? FOLDER_ARCHIVE_DEFAULT_EXCLUDED_NAMES : []
  )
  const rootStat = await lstat(rootRealPath)
  if (!rootStat.isDirectory()) {
    throw new Error('archive_not_directory')
  }
  const plan: FolderArchivePlan = {
    entries: [
      {
        archivePath: `${archiveRootName}/`,
        absolutePath: rootRealPath,
        kind: 'directory',
        size: 0,
        mode: rootStat.mode,
        mtimeMs: rootStat.mtimeMs
      }
    ],
    fileCount: 0,
    directoryCount: 1,
    totalBytes: 0,
    excludedDirCount: 0
  }
  // Depth-first with an explicit stack: deep trees must not grow the JS call stack.
  const pending: { absolutePath: string; archivePath: string }[] = [
    { absolutePath: rootRealPath, archivePath: `${archiveRootName}/` }
  ]
  while (pending.length > 0) {
    if (options.signal?.aborted) {
      throw new Error('archive_canceled')
    }
    const dir = pending.pop()!
    if (dir.absolutePath !== rootRealPath && !(await isUnmovedDirectory(dir.absolutePath))) {
      continue
    }
    let names: string[]
    try {
      names = await readdir(dir.absolutePath)
    } catch (error) {
      if (isVanishedOrDenied(error)) {
        continue
      }
      throw error
    }
    names.sort()
    const stats = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, stat: await lstat(join(dir.absolutePath, name)) }
        } catch (error) {
          if (isVanishedOrDenied(error)) {
            return null
          }
          throw error
        }
      })
    )
    const childDirs: { absolutePath: string; archivePath: string }[] = []
    for (const item of stats) {
      if (!item) {
        continue
      }
      const { name, stat } = item
      const absolutePath = join(dir.absolutePath, name)
      const archivePath = `${dir.archivePath}${name}`
      if (stat.isDirectory()) {
        if (excluded.has(name)) {
          plan.excludedDirCount += 1
          continue
        }
        plan.directoryCount += 1
        plan.entries.push({
          archivePath: `${archivePath}/`,
          absolutePath,
          kind: 'directory',
          size: 0,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs
        })
        childDirs.push({ absolutePath, archivePath: `${archivePath}/` })
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        const kind = stat.isFile() ? 'file' : 'symlink'
        if (kind === 'file') {
          plan.fileCount += 1
          plan.totalBytes += stat.size
          if (plan.totalBytes > maxTotalBytes) {
            throw new FolderArchiveLimitError('archive_too_large')
          }
        }
        plan.entries.push({
          archivePath,
          absolutePath,
          kind,
          size: kind === 'file' ? stat.size : 0,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs
        })
      }
      // Sockets, FIFOs and devices have no archivable content.
      if (plan.entries.length > maxEntries) {
        throw new FolderArchiveLimitError('archive_too_many_entries')
      }
    }
    // Reverse so the stack pops children in sorted order.
    for (let index = childDirs.length - 1; index >= 0; index -= 1) {
      pending.push(childDirs[index])
    }
  }
  return plan
}

async function isUnmovedDirectory(absolutePath: string): Promise<boolean> {
  try {
    const resolved = await realpath(absolutePath)
    // Windows paths compare case-insensitively; realpath may report a different casing.
    return process.platform === 'win32'
      ? resolved.toLowerCase() === absolutePath.toLowerCase()
      : resolved === absolutePath
  } catch (error) {
    if (isVanishedOrDenied(error)) {
      return false
    }
    throw error
  }
}

export function isVanishedOrDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP'
  )
}
