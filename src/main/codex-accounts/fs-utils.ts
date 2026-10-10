import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { nodeFileContentsEqualSync } from '../../shared/node-file-content-equality'
import {
  copyFileWithWindowsRetry,
  renameFileWithWindowsRetry,
  renameFileWithWindowsRetryAsync
} from '../../shared/windows-retry-file-operations'

export { copyFileWithWindowsRetry, renameFileWithWindowsRetry, renameFileWithWindowsRetryAsync }

export function writeFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  options?: { mode?: number }
): void {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    renameFileWithWindowsRetry(tmpPath, targetPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    // Why: on Windows, Chromium's renderer initialization calls
    // SetNamedSecurityInfo on the userData folder with a Protected DACL
    // that propagates empty inherited ACEs to child directories, causing
    // EPERM on all writes. Grant an explicit ACL on the parent directory
    // and retry once so the write succeeds even if Chromium reset the DACL
    // after our startup fix ran.
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(targetPath))
        const retryTmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
        try {
          writeFileSync(retryTmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
          renameFileWithWindowsRetry(retryTmpPath, targetPath)
          return
        } catch {
          rmSync(retryTmpPath, { force: true })
        }
      } catch {
        // icacls failure is not actionable; re-throw the original EPERM
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
  try {
    return attemptGuardedAtomicWrite(targetPath, expectedContents, contents, options)
  } catch (error) {
    if (!isPermissionError(error) || process.platform !== 'win32') {
      throw error
    }
    grantDirAcl(dirname(targetPath))
    return attemptGuardedAtomicWrite(targetPath, expectedContents, contents, options)
  }
}

export function removeFileAtomicallyIfUnchanged(
  targetPath: string,
  expectedContents: string
): boolean {
  const heldPath = getGuardedOperationHeldPath(targetPath)
  recoverInterruptedGuardedOperation(heldPath, targetPath)
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
  try {
    if (!nodeFileContentsEqualSync(heldPath, expectedContents)) {
      restoreMovedFileWithoutOverwrite(heldPath, targetPath)
      return false
    }
    rmSync(heldPath, { force: true })
    return !existsSync(targetPath)
  } catch (error) {
    restoreMovedFileWithoutOverwrite(heldPath, targetPath)
    throw error
  }
}

export function recoverInterruptedGuardedFileOperation(targetPath: string): void {
  recoverInterruptedGuardedOperation(getGuardedOperationHeldPath(targetPath), targetPath)
}

function restoreMovedFileWithoutOverwrite(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) {
    return
  }
  publishFileWithoutOverwrite(sourcePath, targetPath)
  rmSync(sourcePath, { force: true })
}

function getGuardedOperationHeldPath(targetPath: string): string {
  return `${targetPath}.orca-guarded`
}

function recoverInterruptedGuardedOperation(heldPath: string, targetPath: string): void {
  if (!existsSync(heldPath)) {
    return
  }
  publishFileWithoutOverwrite(heldPath, targetPath)
  rmSync(heldPath, { force: true })
}

function attemptGuardedAtomicWrite(
  targetPath: string,
  expectedContents: string | null,
  contents: string,
  options?: { mode?: number }
): boolean {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  const heldPath = getGuardedOperationHeldPath(targetPath)
  recoverInterruptedGuardedOperation(heldPath, targetPath)
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
      rmSync(heldPath, { force: true })
      return false
    }
    rmSync(heldPath, { force: true })
    return true
  } catch (error) {
    restoreMovedFileWithoutOverwrite(heldPath, targetPath)
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
