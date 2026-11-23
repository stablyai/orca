import {
  digestFileContent,
  observedExistsSync as existsSync,
  invalidateFileObservation,
  observeFilePublication
} from './file-content-observation'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl } from '../windows/windows-directory-acl'
import { isPermissionError } from './permission-errors'
import { isHardLinkUnsupported } from './hard-link-unsupported-error'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { nodeFileContentsEqualSync } from '../../shared/file-content/node-file-content-equality'
import { renameFileWithWindowsRetry } from '../../shared/file-write/windows-retry-file-operations'
import { assertGuardedFileCurrent, recordGuardedPublication } from './concurrent-file-edit-guard'

export function writeFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  options?: { mode?: number }
): void {
  // Rechecked before every rename attempt: a Windows retry waits, and another writer can save meanwhile.
  const stillCurrent = (): boolean => {
    assertGuardedFileCurrent(targetPath)
    return true
  }
  let firstError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
      renameFileWithWindowsRetry(tmpPath, targetPath, stillCurrent)
      observeFilePublication(targetPath, contents)
      return
    } catch (error) {
      try {
        rmSync(tmpPath, { force: true })
      } catch (cleanupError) {
        if (attempt === 0) {
          throw cleanupError
        }
      }
      if (attempt > 0) {
        break
      }
      firstError = error
      if (!isPermissionError(error) || process.platform !== 'win32') {
        break
      }
      try {
        // Chromium can reset inherited userData ACLs after startup; repair the parent and retry once.
        grantDirAcl(dirname(targetPath))
      } catch {
        // Preserve the original write error when ACL repair fails.
        break
      }
    }
  }
  throw firstError
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
  let published = false
  for (let attempt = 0; ; attempt++) {
    try {
      published = attemptGuardedAtomicWrite(targetPath, expectedContents, contents, options)
      break
    } catch (error) {
      if (attempt > 0 || !isPermissionError(error) || process.platform !== 'win32') {
        throw error
      }
      grantDirAcl(dirname(targetPath))
    }
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
 * is free). Otherwise it is kept beside it as `<target>.orca-kept-<id>`, with its own permissions: a
 * writer that recreated the target found no file, so the held bytes can be the user's only copy of
 * their settings. Held bytes never go back over a target that a newer writer created. Credentials
 * are dropped instead, as a kept copy would outlive a logout.
 */
function restoreMovedFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  restore = true,
  keep = true
): void {
  let held: Buffer | null = null
  try {
    held = readFileSync(sourcePath)
  } catch (error) {
    // Gone: another process already released this held file. Unreadable: it can't be named by
    // content, so it stays held below.
    if (isDefinitiveAbsence(error)) {
      return
    }
  }
  const drop = (): void => rmSync(sourcePath, { force: true })
  // Named by content, so a repeated conflict finds its copy already kept; a name holding other
  // bytes (a kept copy edited since) moves on to the next. The target comes first.
  const name = held ? createHash('sha256').update(held).digest('hex').slice(0, 16) : null
  for (let attempt = 0; attempt <= (keep ? KEPT_NAME_ATTEMPTS : 0); attempt++) {
    if (attempt > 0 && name === null) {
      break
    }
    const path =
      attempt === 0 ? targetPath : `${targetPath}.orca-kept-${name}${keptSuffix(attempt)}`
    let free = attempt === 0 && restore
    try {
      if (held !== null && nodeFileContentsEqualSync(path, held)) {
        drop()
        return
      }
    } catch (error) {
      free ||= attempt > 0 && isDefinitiveAbsence(error)
    }
    if (!free) {
      continue
    }
    try {
      // A link refuses a name another program took meanwhile and keeps the file's permissions. A
      // crash before the held name goes leaves two equal files, and the next try drops the held one.
      if (publishHeldFile(sourcePath, path)) {
        drop()
        if (attempt > 0) {
          console.warn('[atomic-file] Kept an earlier version beside', targetPath, path)
        }
        return
      }
    } catch (error) {
      // Gone: another process already released this held file.
      if (isDefinitiveAbsence(error)) {
        return
      }
      throw error
    }
  }
  if (!keep) {
    drop()
    return
  }
  // Left held, so the next guarded operation tries again: unreadable, or every content name holds
  // other bytes and a copy per conflict would grow unbounded.
  throw new Error(`Could not keep an earlier version of ${targetPath}`)
}

const KEPT_NAME_ATTEMPTS = 16

function keptSuffix(attempt: number): string {
  return attempt > 1 ? `-${attempt - 1}` : ''
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
  // How the held file goes back once this attempt ends; null when nothing was held.
  let restoreHeld: boolean | null = null
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    if (expectedContents === null) {
      return publishHeldFile(tmpPath, targetPath)
    }
    try {
      assertHardLinkPublicationSupported(tmpPath, targetPath)
    } catch (error) {
      // Why: \\wsl$ shares and FAT/exFAT have no hard links, so they go on to the rename path below.
      if (!isHardLinkUnsupported(error)) {
        throw error
      }
    }
    try {
      renameFileWithWindowsRetry(targetPath, heldPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
    if (!nodeFileContentsEqualSync(heldPath, expectedContents)) {
      restoreHeld = true
      return false
    }
    if (!publishHeldFile(tmpPath, targetPath)) {
      // Another writer's file supersedes the held one, even if it is deleted again meanwhile.
      superseded = true
      restoreHeld = false
      return false
    }
    rmSync(heldPath, { force: true })
    return true
  } catch (error) {
    restoreHeld = !superseded
    throw error
  } finally {
    try {
      if (restoreHeld !== null) {
        restoreMovedFileWithoutOverwrite(heldPath, targetPath, restoreHeld, keep)
      }
    } finally {
      rmSync(tmpPath, { force: true })
    }
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

// No hard links and no no-replace rename in Node: a save landing between this lstat and the rename is still replaced; the window is only that pair.
function publishHeldFile(sourcePath: string, targetPath: string): boolean {
  try {
    return publishFileWithoutOverwrite(sourcePath, targetPath)
  } catch (error) {
    if (!isHardLinkUnsupported(error)) {
      throw error
    }
  }
  try {
    lstatSync(targetPath)
    return false
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  renameSync(sourcePath, targetPath)
  return true
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
