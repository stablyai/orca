import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'

export function writeFileAtomically(
  targetPath: string,
  contents: string,
  options?: { mode?: number }
): void {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    renameWithRetry(tmpPath, targetPath)
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
          renameWithRetry(retryTmpPath, targetPath)
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

// Why: on Windows, renameSync can fail with EPERM/EACCES/EBUSY if another
// process (antivirus, Claude CLI, Codex CLI) holds the target file open.
// A short retry avoids transient failures without masking real permission
// errors. Total backoff (~750ms) covers typical AV scan windows seen in
// issue #1507.
function renameWithRetry(source: string, target: string): void {
  const maxAttempts = process.platform === 'win32' ? 6 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(source, target)
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
