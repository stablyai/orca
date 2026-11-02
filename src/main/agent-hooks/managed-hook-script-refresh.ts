import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { grantDirAclAsync, isPermissionError } from '../win32-utils'
import { renameOverLockedTargetAsync } from './locked-executable-rename'

type ExistingScript = { exists: false } | { exists: true; content: Buffer | null }

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readExistingScript(scriptPath: string): Promise<ExistingScript> {
  try {
    return { exists: true, content: await readFile(scriptPath) }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false }
    }
    try {
      await stat(scriptPath)
      return { exists: true, content: null }
    } catch (statError) {
      if (isMissingPathError(statError)) {
        return { exists: false }
      }
      throw error
    }
  }
}

export async function scriptStillExists(scriptPath: string): Promise<boolean> {
  try {
    await stat(scriptPath)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

async function writeScriptWithAclRetry(
  scriptPath: string,
  content: string | Buffer
): Promise<void> {
  try {
    await writeFile(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        await grantDirAclAsync(dirname(scriptPath))
        await writeFile(scriptPath, content, 'utf-8')
        return
      } catch {
        // Re-throw the original permission error.
      }
    }
    throw error
  }
}

// Why: refresh must not block Electron's main thread or create state for an absent CLI.
export async function refreshManagedScriptIfPresent(
  scriptPath: string,
  content: string | Buffer,
  options: { moveLockedTargetAside?: boolean } = {}
): Promise<boolean> {
  return writeManagedScriptAtomically(
    scriptPath,
    content,
    false,
    options.moveLockedTargetAside === true
  )
}

// Callers must establish ownership from a surviving managed script or registration first.
export async function restoreManagedScript(scriptPath: string, content: string): Promise<void> {
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeManagedScriptAtomically(scriptPath, content, true)
}

async function writeManagedScriptAtomically(
  scriptPath: string,
  content: string | Buffer,
  allowMissing: boolean,
  moveLockedTargetAside = false
): Promise<boolean> {
  const existing = await readExistingScript(scriptPath)
  if (!existing.exists && !allowMissing) {
    return false
  }
  if (existing.exists && existing.content?.equals(Buffer.from(content))) {
    if (process.platform !== 'win32') {
      await chmod(scriptPath, 0o755)
    }
    return true
  }

  const tmpPath = join(dirname(scriptPath), `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    await writeScriptWithAclRetry(tmpPath, content)
    if (process.platform !== 'win32') {
      await chmod(tmpPath, 0o755)
    }
    if (!allowMissing && !(await scriptStillExists(scriptPath))) {
      return false
    }
    await renameOverLockedTargetAsync(tmpPath, scriptPath, moveLockedTargetAside)
    return true
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}
