import { readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Why: a registry that failed to parse may still be restored from backup, and until it is,
// "this device is not listed" proves nothing — a keyed client would delete its key on that verdict.
function corruptCopyPrefix(registryPath: string): string {
  return `${basename(registryPath)}.corrupt-`
}

export function corruptRegistryCopyExists(registryPath: string): boolean {
  try {
    const prefix = corruptCopyPrefix(registryPath)
    return readdirSync(dirname(registryPath)).some((name) => name.startsWith(prefix))
  } catch {
    return false
  }
}

/** Moves an unparseable registry aside so the first rewrite cannot destroy it. */
export function quarantineCorruptRegistry(registryPath: string): void {
  const target = join(dirname(registryPath), `${corruptCopyPrefix(registryPath)}${Date.now()}`)
  try {
    renameSync(registryPath, target)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
