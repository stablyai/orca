import {
  readObservedFileSync as readFileSync,
  observedExistsSync as existsSync
} from '../../../filesystem/file-content-observation'
import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'

import { dirname, join } from 'node:path'

import { randomUUID } from 'node:crypto'
import { grantDirAcl } from '../../../windows/windows-directory-acl'
import { isPermissionError } from '../../../filesystem/permission-errors'
import { renameOverLockedTarget } from './locked-executable-rename'
import { observeFilePublication } from '../../../filesystem/file-content-observation'

// Atomic replacement protects scripts being read by in-flight hooks.
export function writeManagedScript(
  scriptPath: string,
  content: string | Buffer,
  options: { moveLockedTargetAside?: boolean } = {}
): void {
  const dir = dirname(scriptPath)
  mkdirSync(dir, { recursive: true })

  if (existsSync(scriptPath)) {
    try {
      if (readFileSync(scriptPath).equals(Buffer.from(content))) {
        if (process.platform !== 'win32') {
          chmodSync(scriptPath, 0o755)
        }
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }

  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeScriptWithAclRetry(tmpPath, content)
    // Publish with execute permission so POSIX guards never skip a newly installed script.
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, 0o755)
    }
    renameOverLockedTarget(tmpPath, scriptPath, options.moveLockedTargetAside === true)
    observeFilePublication(scriptPath, content)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

// Retry Windows EPERM once after repairing a restrictive directory ACL.
function writeScriptWithAclRetry(scriptPath: string, content: string | Buffer): void {
  try {
    writeFileSync(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(scriptPath))
        writeFileSync(scriptPath, content, 'utf-8')
        return
      } catch {
        // a failed grant is not actionable; re-throw the original EPERM
      }
    }
    throw error
  }
}
