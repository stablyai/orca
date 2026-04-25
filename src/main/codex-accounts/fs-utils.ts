import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'

export async function writeFileAtomically(
  targetPath: string,
  contents: string,
  options?: { mode?: number }
): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
    await renameWithRetry(tmpPath, targetPath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
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
          await fs.writeFile(retryTmpPath, contents, { encoding: 'utf-8', mode: options?.mode })
          await renameWithRetry(retryTmpPath, targetPath)
          return
        } catch {
          await fs.rm(retryTmpPath, { force: true }).catch(() => {})
        }
      } catch {
        // icacls failure is not actionable; re-throw the original EPERM
      }
    }
    throw error
  }
}

// Why: on Windows, renameSync can fail with EPERM/EACCES if another process
// (antivirus, Codex CLI) holds the target file open. A short retry avoids
// transient failures without masking real permission errors.
async function renameWithRetry(source: string, target: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < maxAttempts && (code === 'EPERM' || code === 'EACCES')) {
        const delayMs = attempt * 50
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      throw error
    }
  }
}
