import {
  digestFileContent,
  observedExistsSync as existsSync,
  invalidateFileObservation,
  observeFilePublication
} from './file-content-observation'
import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl } from '../windows/windows-directory-acl'
import { isPermissionError } from './permission-errors'
import { nodeFileContentsEqualSync } from '../../shared/file-content/node-file-content-equality'
import { renameFileWithWindowsRetry } from '../../shared/file-write/windows-retry-file-operations'
import { assertGuardedFileCurrent, recordGuardedPublication } from './concurrent-file-edit-guard'

export function writeFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  options?: { mode?: number }
): void {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  // Rechecked before every rename attempt: a Windows retry waits, and another writer can save meanwhile.
  const stillCurrent = (): boolean => {
    assertGuardedFileCurrent(targetPath)
    return true
  }
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    renameFileWithWindowsRetry(tmpPath, targetPath, stillCurrent)
    observeFilePublication(targetPath, contents)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    // Chromium can reset inherited userData ACLs after startup; repair the parent and retry once.
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(targetPath))
        const retryTmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
        try {
          writeFileSync(retryTmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
          renameFileWithWindowsRetry(retryTmpPath, targetPath, stillCurrent)
          observeFilePublication(targetPath, contents)
          return
        } catch {
          rmSync(retryTmpPath, { force: true })
        }
      } catch {
        // Preserve the original write error when ACL repair fails.
      }
    }
    throw error
  }
}

export function writeFileAtomicallyIfUnchanged(
  targetPath: string,
  expectedContents: string | null,
  contents: string,
  options?: { mode?: number }
): boolean {
  // Guarded recovery moves files through a held name; keep those passes eligible for retry.
  invalidateFileObservation(targetPath)
  assertGuardedFileCurrent(targetPath)
  let published: boolean
  try {
    published = attemptGuardedAtomicWrite(targetPath, expectedContents, contents, options)
  } catch (error) {
    if (!isPermissionError(error) || process.platform !== 'win32') {
      throw error
    }
    grantDirAcl(dirname(targetPath))
    published = attemptGuardedAtomicWrite(targetPath, expectedContents, contents, options)
  }
  if (published) {
    recordGuardedPublication(targetPath, () => digestFileContent(contents))
  }
  return published
}

export function removeFileAtomicallyIfUnchanged(
  targetPath: string,
  expectedContents: string
): boolean {
  invalidateFileObservation(targetPath)
  const heldPath = getGuardedOperationHeldPath(targetPath)
  restoreMovedFileWithoutOverwrite(heldPath, targetPath)
  try {
    assertHardLinkPublicationSupported(targetPath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
  try {
    renameFileWithWindowsRetry(targetPath, heldPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
  let matched = false
  try {
    matched = nodeFileContentsEqualSync(heldPath, expectedContents)
    if (matched) {
      rmSync(heldPath, { force: true })
    }
  } finally {
    // A mismatch or a failure puts the held file back; a removed one is already gone.
    restoreMovedFileWithoutOverwrite(heldPath, targetPath)
  }
  return matched && !existsSync(targetPath)
}

export function recoverInterruptedGuardedFileOperation(targetPath: string): void {
  restoreMovedFileWithoutOverwrite(getGuardedOperationHeldPath(targetPath), targetPath)
}

/**
 * Drops a held file once its bytes are back at the target (`restore` puts them back when the target
 * is free). Otherwise its bytes stay beside the target in a new owner-only file: a writer that
 * recreated the target found no file, so the held bytes can be the user's only copy of their
 * settings or sign-in. Held bytes never go back over a target that a newer writer created.
 */
function restoreMovedFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  restore = true
): void {
  if (!existsSync(sourcePath)) {
    return
  }
  if (restore && publishFileWithoutOverwrite(sourcePath, targetPath)) {
    rmSync(sourcePath, { force: true })
    return
  }
  // Read through a held link: the copy must not share or re-permission what it points at.
  const held = readFileSync(sourcePath)
  let matches = false
  try {
    matches = nodeFileContentsEqualSync(targetPath, held)
  } catch {
    // An unreadable or vanished target proves nothing: keep the held bytes.
  }
  if (!matches) {
    const keptPath = `${targetPath}.orca-kept-${randomUUID()}`
    writeFileSync(keptPath, held, { mode: 0o600, flag: 'wx' })
    console.warn('[atomic-file] Kept an earlier version beside', targetPath, keptPath)
  }
  rmSync(sourcePath, { force: true })
}

export function getGuardedOperationHeldPath(targetPath: string): string {
  return `${targetPath}.orca-guarded`
}

function attemptGuardedAtomicWrite(
  targetPath: string,
  expectedContents: string | null,
  contents: string,
  options?: { mode?: number }
): boolean {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  const heldPath = getGuardedOperationHeldPath(targetPath)
  restoreMovedFileWithoutOverwrite(heldPath, targetPath)
  let superseded = false
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    if (expectedContents === null) {
      return publishFileWithoutOverwrite(tmpPath, targetPath)
    }
    assertHardLinkPublicationSupported(tmpPath, targetPath)
    try {
      renameFileWithWindowsRetry(targetPath, heldPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
    if (!nodeFileContentsEqualSync(heldPath, expectedContents)) {
      restoreMovedFileWithoutOverwrite(heldPath, targetPath)
      return false
    }
    if (!publishFileWithoutOverwrite(tmpPath, targetPath)) {
      // Another writer's file supersedes the held one, even if it is deleted again meanwhile.
      superseded = true
      restoreMovedFileWithoutOverwrite(heldPath, targetPath, false)
      return false
    }
    rmSync(heldPath, { force: true })
    return true
  } catch (error) {
    restoreMovedFileWithoutOverwrite(heldPath, targetPath, !superseded)
    throw error
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

function assertHardLinkPublicationSupported(sourcePath: string, targetPath: string): void {
  const probePath = `${targetPath}.${process.pid}.${randomUUID()}.link-probe`
  try {
    if (!publishFileWithoutOverwrite(sourcePath, probePath)) {
      throw new Error(`Guarded file publication probe already exists: ${probePath}`)
    }
  } finally {
    rmSync(probePath, { force: true })
  }
}

export function publishFileWithoutOverwrite(sourcePath: string, targetPath: string): boolean {
  try {
    linkSync(sourcePath, targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    if (isPermissionError(error) && process.platform === 'win32') {
      grantDirAcl(dirname(targetPath))
      try {
        linkSync(sourcePath, targetPath)
        return true
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
          return false
        }
        throw retryError
      }
    }
    throw error
  }
}
