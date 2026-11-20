import {
  digestFileContent,
  observedExistsSync as existsSync,
  invalidateFileObservation,
  observeFilePublication
} from './file-content-observation'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl } from '../windows/windows-directory-acl'
import { isPermissionError } from './permission-errors'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
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

/**
 * `credential`: an earlier copy that conflicts with a recreated file is dropped as before, never
 * kept beside it. A login can be signed in again; a token left behind can outlive a logout.
 */
export type GuardedFileOptions = { mode?: number; credential?: boolean }

export function writeFileAtomicallyIfUnchanged(
  targetPath: string,
  expectedContents: string | null,
  contents: string,
  options?: GuardedFileOptions
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
  expectedContents: string,
  options?: GuardedFileOptions
): boolean {
  invalidateFileObservation(targetPath)
  const heldPath = getGuardedOperationHeldPath(targetPath)
  const keep = !options?.credential
  restoreMovedFileWithoutOverwrite(heldPath, targetPath, true, keep)
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
  let removed = false
  try {
    matched = nodeFileContentsEqualSync(heldPath, expectedContents)
    if (matched) {
      rmSync(heldPath, { force: true })
      removed = true
    }
  } finally {
    // A mismatch or a failure puts the held file back. After a removal the held name may already
    // be another removal's, which that one restores or drops itself.
    if (!removed) {
      restoreMovedFileWithoutOverwrite(heldPath, targetPath, true, keep)
    }
  }
  return matched && !existsSync(targetPath)
}

export function recoverInterruptedGuardedFileOperation(
  targetPath: string,
  options?: GuardedFileOptions
): void {
  const heldPath = getGuardedOperationHeldPath(targetPath)
  restoreMovedFileWithoutOverwrite(heldPath, targetPath, true, !options?.credential)
}

/**
 * Drops a held file once its bytes are back at the target (`restore` puts them back when the target
 * is free). Otherwise it moves aside to `<target>.orca-kept-<id>`, keeping its own permissions: a
 * writer that recreated the target found no file, so the held bytes can be the user's only copy of
 * their settings or sign-in. Held bytes never go back over a target that a newer writer created.
 */
function restoreMovedFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  restore = true,
  keep = true
): void {
  if (!existsSync(sourcePath)) {
    return
  }
  const drop = (): void => rmSync(sourcePath, { force: true })
  if (restore && publishFileWithoutOverwrite(sourcePath, targetPath)) {
    drop()
    return
  }
  let held: Buffer | null = null
  try {
    held = readFileSync(sourcePath)
  } catch {
    // Unreadable or vanished: nothing proves these bytes are kept elsewhere.
  }
  // Named by content: a conflict that repeats with the same bytes finds its copy already kept.
  const name = held ? createHash('sha256').update(held).digest('hex').slice(0, 16) : randomUUID()
  let keptPath = `${targetPath}.orca-kept-${name}`
  let keptPathFree = held === null
  const kept = (keep && held ? [targetPath, keptPath] : [targetPath]).some((path) => {
    try {
      return held !== null && nodeFileContentsEqualSync(path, held)
    } catch (error) {
      keptPathFree ||= path === keptPath && isDefinitiveAbsence(error)
      return false
    }
  })
  if (kept || !keep) {
    drop()
    return
  }
  if (!keptPathFree) {
    // A copy by that name holds other bytes now (edited since): these are kept beside it.
    keptPath = `${targetPath}.orca-kept-${randomUUID()}`
  }
  try {
    // A rename needs no free space and never widens who can read the file.
    renameFileWithWindowsRetry(sourcePath, keptPath)
  } catch (error) {
    // Another process already released this held file.
    if (isDefinitiveAbsence(error)) {
      return
    }
    // Left held, the next guarded operation keeps it first, and fails until it can.
    throw error
  }
  console.warn('[atomic-file] Kept an earlier version beside', targetPath, keptPath)
}

export function getGuardedOperationHeldPath(targetPath: string): string {
  return `${targetPath}.orca-guarded`
}

function attemptGuardedAtomicWrite(
  targetPath: string,
  expectedContents: string | null,
  contents: string,
  options?: GuardedFileOptions
): boolean {
  const keep = !options?.credential
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  const heldPath = getGuardedOperationHeldPath(targetPath)
  restoreMovedFileWithoutOverwrite(heldPath, targetPath, true, keep)
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
      restoreMovedFileWithoutOverwrite(heldPath, targetPath, true, keep)
      return false
    }
    if (!publishFileWithoutOverwrite(tmpPath, targetPath)) {
      // Another writer's file supersedes the held one, even if it is deleted again meanwhile.
      superseded = true
      restoreMovedFileWithoutOverwrite(heldPath, targetPath, false, keep)
      return false
    }
    rmSync(heldPath, { force: true })
    return true
  } catch (error) {
    restoreMovedFileWithoutOverwrite(heldPath, targetPath, !superseded, keep)
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
