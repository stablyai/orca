import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { nodeFileContentsEqualSync } from '../../shared/node-file-content-equality'

export function writeFileAtomically(
  targetPath: string,
  contents: string,
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

function publishFileWithoutOverwrite(sourcePath: string, targetPath: string): boolean {
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

// Why: on Windows, file replacement and backup-copy operations can fail with
// EPERM/EACCES/EBUSY if another process (antivirus, Claude CLI, Codex CLI)
// holds the target file open. A short retry avoids transient failures without
// masking real permission errors. Total backoff (~750ms) covers typical AV
// scan windows seen in issue #1507.
export function renameFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => renameSync(source, target))
}

export function copyFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => copyFileSync(source, target))
}

function runFileOperationWithWindowsRetry(operation: () => void): void {
  const maxAttempts = process.platform === 'win32' ? 6 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      operation()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < maxAttempts && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        sleepSync(attempt * 50)
        continue
      }
      throw error
    }
  }
}

// Why: writeFileAtomically is a sync API called from sync paths, so the retry
// backoff must park the thread instead of burning CPU in a Date.now() loop.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}
