import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { DirEntry, FilesystemPathFlavor } from '../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../shared/file-name-sort'
import { gitExecFileAsync } from '../git/runner'
import { isServerDriveListRequest, listWindowsDrives } from './windows-drive-listing'

function resolveServerBrowsePath(pathValue: string): string {
  const trimmed = pathValue.trim() || '~'
  if (trimmed.includes('\0')) {
    throw new Error('Path cannot contain null bytes')
  }
  if (trimmed === '~') {
    return homedir()
  }
  if (/^~[\\/]/.test(trimmed)) {
    return resolve(homedir(), trimmed.slice(2))
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed)
  }
  return resolve(homedir(), trimmed)
}

export class RuntimeServerEnvironmentCommands {
  async browseDirectory(pathValue: string): Promise<{
    resolvedPath: string
    entries: DirEntry[]
    pathFlavor: FilesystemPathFlavor
  }> {
    if (isServerDriveListRequest(pathValue)) {
      return listWindowsDrives()
    }
    const dirPath = resolveServerBrowsePath(pathValue)
    const dirStat = await stat(dirPath)
    if (!dirStat.isDirectory()) {
      throw new Error(`${dirPath} is not a directory`)
    }
    const entries = await readdir(dirPath, { withFileTypes: true })
    const mapped = entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    sortDirEntries(mapped)
    return {
      resolvedPath: dirPath,
      entries: mapped,
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix'
    }
  }

  async isGitAvailable(): Promise<boolean> {
    try {
      await gitExecFileAsync(['--version'], { cwd: process.cwd(), timeout: 3000 })
      return true
    } catch {
      return false
    }
  }
}
