import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import '../../../filesystem/atomic-file-publication'
import { renameFileWithWindowsRetry } from '../../../../shared/file-write/windows-retry-file-operations'
import { writeRollingFileBackup } from '../../../filesystem/rolling-file-backup'
import { assertGuardedFileCurrent } from '../../../filesystem/concurrent-file-edit-guard'
import {
  observeFilePublication,
  observedExistsSync as existsSync,
  observeFileReadError,
  observeResolvedFilePath
} from '../../../filesystem/file-content-observation'

/**
 * Returns false without publishing when `stillCurrent` says the file changed since the caller read
 * it, so a writer on another thread can redo its edit instead of clobbering a newer one.
 */
export function writeTomlConfigAtomically(
  configPath: string,
  contents: string,
  options?: { stillCurrent: (writePath: string) => boolean }
): boolean {
  const writePath = resolveTomlWritePath(configPath)
  const directory = dirname(writePath)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(directory, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: 'utf-8',
      mode: resolveCodexConfigTomlFileMode(writePath)
    })
    // A rejected update must not rotate the backup first.
    assertGuardedFileCurrent(writePath)
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    // Checked before every rename attempt, so only the re-read is left between check and rename.
    const stillCurrent = (): boolean => {
      assertGuardedFileCurrent(writePath)
      return options ? options.stillCurrent(writePath) : true
    }
    if (!renameFileWithWindowsRetry(temporaryPath, writePath, stillCurrent)) {
      return false
    }
    observeFilePublication(writePath, contents)
    renamed = true
    return true
  } finally {
    if (!renamed && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // Cleanup failure must not mask the write failure.
      }
    }
  }
}

/** Preserve existing permissions; new configs are owner-only because MCP entries may hold tokens. */
export function resolveCodexConfigTomlFileMode(configPath: string): number {
  try {
    return statSync(configPath).mode & 0o777
  } catch (error) {
    observeFileReadError(configPath, error)
    return 0o600
  }
}

export function resolveTomlWritePath(configPath: string): string {
  let isSymlink = false
  try {
    isSymlink = lstatSync(configPath).isSymbolicLink()
  } catch (error) {
    observeFileReadError(configPath, error)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  // Preserve dotfile symlinks; refuse writes through unresolved dangling links.
  return observeResolvedFilePath(
    'toml-write',
    configPath,
    isSymlink ? realpathSync.native(configPath) : configPath
  )
}
