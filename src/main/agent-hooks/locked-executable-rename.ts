import { existsSync, renameSync, rmSync } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { isPermissionError } from '../win32-utils'

/**
 * Where a copy still running from the previous build is moved so the new file can take its name.
 * Windows refuses to replace a running executable but lets it be renamed; the next install deletes
 * the aside, and while the aside itself still runs, a further replacement throws.
 */
export function getLockedExecutableAsidePath(targetPath: string): string {
  return `${targetPath}.old`
}

export function renameOverLockedTarget(
  tmpPath: string,
  targetPath: string,
  moveLockedTargetAside: boolean
): void {
  try {
    renameSync(tmpPath, targetPath)
  } catch (error) {
    if (!moveLockedTargetAside || !isPermissionError(error)) {
      throw error
    }
    const asidePath = getLockedExecutableAsidePath(targetPath)
    rmSync(asidePath, { force: true })
    renameSync(targetPath, asidePath)
    try {
      renameSync(tmpPath, targetPath)
    } catch (placeError) {
      // Put the running copy back so the registered command never points at a missing file.
      if (!existsSync(targetPath)) {
        renameSync(asidePath, targetPath)
      }
      throw placeError
    }
  }
}

export async function renameOverLockedTargetAsync(
  tmpPath: string,
  targetPath: string,
  moveLockedTargetAside: boolean
): Promise<void> {
  try {
    await rename(tmpPath, targetPath)
  } catch (error) {
    if (!moveLockedTargetAside || !isPermissionError(error)) {
      throw error
    }
    const asidePath = getLockedExecutableAsidePath(targetPath)
    await rm(asidePath, { force: true })
    await rename(targetPath, asidePath)
    try {
      await rename(tmpPath, targetPath)
    } catch (placeError) {
      // Same rollback as the sync path.
      const targetExists = await stat(targetPath).then(
        () => true,
        () => false
      )
      if (!targetExists) {
        await rename(asidePath, targetPath)
      }
      throw placeError
    }
  }
}
