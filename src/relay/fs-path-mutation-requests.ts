import { writeFile, stat, lstat, mkdir, rename, cp, rm } from 'node:fs/promises'
import { expandTilde } from './context'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'
import type { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'

export async function writeRelayFile(params: Record<string, unknown>) {
  const filePath = expandTilde(params.filePath as string)
  const content = params.content as string
  try {
    const fileStats = await lstat(filePath)
    if (fileStats.isDirectory()) {
      throw new Error('Cannot write to a directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  await writeFile(filePath, content, 'utf-8')
}

export async function deleteRelayPath(
  params: Record<string, unknown>,
  watchRegistry: RelayFilesystemWatchRegistry
) {
  const targetPath = expandTilde(params.targetPath as string)
  const recursive = params.recursive as boolean | undefined
  const stats = await stat(targetPath)
  if (stats.isDirectory() && !recursive) {
    throw new Error('Cannot delete directory without recursive flag')
  }
  const remove = () => rm(targetPath, { recursive: !!recursive, force: true })
  if (stats.isDirectory()) {
    // Why: forced orphan cleanup bypasses git.removeWorktree but must hold
    // the same relay-wide watcher fence through recursive deletion.
    await watchRegistry.runWithRemovalFence(targetPath, remove)
    return
  }
  await remove()
}

export async function createRelayFile(params: Record<string, unknown>) {
  const filePath = expandTilde(params.filePath as string)
  const { dirname } = await import('node:path')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
}

export async function createRelayDir(params: Record<string, unknown>) {
  const dirPath = expandTilde(params.dirPath as string)
  await mkdir(dirPath, { recursive: true })
}

export async function createRelayDirNoClobber(params: Record<string, unknown>) {
  const dirPath = expandTilde(params.dirPath as string)
  await mkdir(dirPath, { recursive: false })
}

export async function renameRelayPath(params: Record<string, unknown>) {
  const oldPath = expandTilde(params.oldPath as string)
  const newPath = expandTilde(params.newPath as string)
  await rename(oldPath, newPath)
}

export async function renameRelayPathNoClobber(params: Record<string, unknown>) {
  const oldPath = expandTilde(params.oldPath as string)
  const newPath = expandTilde(params.newPath as string)
  // Why: user-facing file renames must not inherit fs.rename's overwrite
  // behavior; keep the guard inside the relay so SSH checks the remote FS.
  await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
  await rename(oldPath, newPath)
}

export async function copyRelayPath(params: Record<string, unknown>) {
  const source = expandTilde(params.source as string)
  const destination = expandTilde(params.destination as string)
  try {
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
      throw new Error('EEXIST: destination already exists')
    }
    throw error
  }
}
