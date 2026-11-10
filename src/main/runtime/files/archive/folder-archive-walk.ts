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
  /** Walk-time identity; the zip stream refuses to read a file whose dev/ino changed since. */
  dev: number
  ino: number
}

export type FolderArchivePlan = {
  /** Canonical path of the archived folder; every read must land under it. */
  rootRealPath: string
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
  // The caller hands over the authorized, canonical path. If it no longer resolves to itself (the
  // folder was swapped for a link after authorization), refuse rather than walk wherever it points.
  const rootRealPath = await realpath(rootPath)
  const sameRoot =
    process.platform === 'win32'
      ? rootRealPath.toLowerCase() === rootPath.toLowerCase()
      : rootRealPath === rootPath
  if (!sameRoot) {
    throw new Error('archive_not_directory')
  }
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
    rootRealPath,
    entries: [
      {
        archivePath: `${archiveRootName}/`,
        absolutePath: rootRealPath,
        kind: 'directory',
        size: 0,
        mode: rootStat.mode,
        mtimeMs: rootStat.mtimeMs,
        dev: rootStat.dev,
        ino: rootStat.ino
      }
    ],
    fileCount: 0,
    directoryCount: 1,
    totalBytes: 0,
    excludedDirCount: 0
  }
  // Depth-first with an explicit stack: deep trees must not grow the JS call stack.
  const pending: PendingDirectory[] = [
    {
      absolutePath: rootRealPath,
      archivePath: `${archiveRootName}/`,
      dev: rootStat.dev,
      ino: rootStat.ino
    }
  ]
  while (pending.length > 0) {
    if (options.signal?.aborted) {
      throw new Error('archive_canceled')
    }
    const dir = pending.pop()!
    if (!(await isUnmovedDirectory(dir))) {
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
    // A directory swapped for a link while it was listed would have its children lstat'ed outside
    // the root; check it again and drop the whole listing if it moved.
    if (!(await isUnmovedDirectory(dir))) {
      continue
    }
    const childDirs: PendingDirectory[] = []
    // ZIP extractors on macOS and Windows fold case and Unicode form, so `A` and `a` (or NFC and
    // NFD spellings) would land on one path; later twins get a ` (2)` suffix instead.
    const usedNames = new Set<string>()
    for (const item of stats) {
      if (!item) {
        continue
      }
      const { name, stat } = item
      const absolutePath = join(dir.absolutePath, name)
      const archivePath = `${dir.archivePath}${uniqueArchiveSegment(sanitizeArchiveSegment(name), usedNames)}`
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
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino
        })
        childDirs.push({
          absolutePath,
          archivePath: `${archivePath}/`,
          dev: stat.dev,
          ino: stat.ino
        })
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
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino
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

/**
 * One path segment as stored in the ZIP. Linux allows `\` and control characters in names; Windows
 * extractors treat `\` as a separator, so a file named `..\..\x` would escape the extract folder.
 */
export function sanitizeArchiveSegment(name: string): string {
  // Bidi overrides and zero-width characters let `exe.txt` display as `txt.exe`; drop them.
  const visible = name.replace(INVISIBLE_FORMAT_CHARS, '')
  // Windows refuses these characters (`:` can even open an alternate data stream) and drops
  // trailing dots and spaces, so map them as local download names are mapped. `.`/`..` become `_`/`__`.
  const cleaned = visible
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\:*?"<>|]/g, '_')
    .replace(/[. ]+$/, (tail) => '_'.repeat(tail.length))
  if (cleaned === '') {
    return '_'
  }
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned
}

// Superscript digits written as escapes: the orcad bundle must stay ASCII.
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(?:\..*)?$/i

const INVISIBLE_FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

function uniqueArchiveSegment(segment: string, used: Set<string>): string {
  const fold = (value: string) => value.normalize('NFC').toLowerCase()
  let candidate = segment
  const dot = segment.lastIndexOf('.')
  const stem = dot > 0 ? segment.slice(0, dot) : segment
  const extension = dot > 0 ? segment.slice(dot) : ''
  for (let copy = 2; used.has(fold(candidate)); copy += 1) {
    candidate = `${stem} (${copy})${extension}`
  }
  used.add(fold(candidate))
  return candidate
}

type PendingDirectory = { absolutePath: string; archivePath: string; dev: number; ino: number }

async function isUnmovedDirectory(dir: PendingDirectory): Promise<boolean> {
  try {
    const resolved = await realpath(dir.absolutePath)
    // Windows paths compare case-insensitively; realpath may report a different casing.
    const samePath =
      process.platform === 'win32'
        ? resolved.toLowerCase() === dir.absolutePath.toLowerCase()
        : resolved === dir.absolutePath
    if (!samePath) {
      return false
    }
    const current = await lstat(dir.absolutePath)
    return current.isDirectory() && current.dev === dir.dev && current.ino === dir.ino
  } catch (error) {
    if (isVanishedOrDenied(error)) {
      return false
    }
    throw error
  }
}

export function isVanishedOrDenied(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP'
  )
}
