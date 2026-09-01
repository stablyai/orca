import { readdir, stat, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { sortDirEntries } from '../shared/file-name-sort'
import { expandTilde } from './context'

async function resolveSymlinkDirectoryEntry(
  dirPath: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
): Promise<boolean> {
  try {
    // Why: the file explorer needs target type for symlinked directories so a
    // workspace link to an external folder expands instead of opening as a file.
    return (await stat(join(dirPath, entry.name))).isDirectory()
  } catch {
    return false
  }
}

function fileStatFromLstat(stats: Awaited<ReturnType<typeof lstat>>) {
  let type: 'file' | 'directory' | 'symlink' = 'file'
  if (stats.isDirectory()) {
    type = 'directory'
  } else if (stats.isSymbolicLink()) {
    type = 'symlink'
  }
  return {
    size: stats.size,
    type,
    mtime: stats.mtimeMs,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink
  }
}

export async function readRelayDir(params: Record<string, unknown>) {
  const dirPath = expandTilde(params.dirPath as string)
  const entries = await readdir(dirPath, { withFileTypes: true })
  const mapped: { name: string; isDirectory: boolean; isSymlink: boolean }[] = []
  const symlinkProbes: Promise<void>[] = []
  for (const entry of entries) {
    const mappedEntry = {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink()
    }
    mapped.push(mappedEntry)
    if (!mappedEntry.isDirectory && mappedEntry.isSymlink) {
      symlinkProbes.push(
        resolveSymlinkDirectoryEntry(dirPath, entry).then((isDirectory) => {
          mappedEntry.isDirectory = isDirectory
        })
      )
    }
  }
  if (symlinkProbes.length > 0) {
    await Promise.all(symlinkProbes)
  }
  return sortDirEntries(mapped)
}

export async function statRelayPath(params: Record<string, unknown>) {
  const filePath = expandTilde(params.filePath as string)
  const stats = await lstat(filePath)
  if (stats.isSymbolicLink()) {
    try {
      // Why: callers use stat to decide whether to read a path or enumerate
      // it; symlink-to-directory must behave like its target for that choice.
      const targetStats = await stat(filePath)
      return {
        size: targetStats.size,
        type: targetStats.isDirectory() ? 'directory' : 'file',
        mtime: targetStats.mtimeMs,
        mtimeMs: targetStats.mtimeMs,
        dev: targetStats.dev,
        ino: targetStats.ino,
        nlink: targetStats.nlink
      }
    } catch {
      return { size: stats.size, type: 'symlink', mtime: stats.mtimeMs }
    }
  }
  return fileStatFromLstat(stats)
}

export async function lstatRelayPath(params: Record<string, unknown>) {
  const filePath = expandTilde(params.filePath as string)
  return fileStatFromLstat(await lstat(filePath))
}

export async function realpathRelayPath(params: Record<string, unknown>) {
  const filePath = expandTilde(params.filePath as string)
  return await realpath(filePath)
}
