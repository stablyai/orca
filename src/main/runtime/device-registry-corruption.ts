import { readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Corrupt registries may recover from backup; absence cannot justify a client erasing its key.
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
