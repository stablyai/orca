import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import '../../../filesystem/atomic-file-publication'
import { renameFileWithWindowsRetry } from '../../../../shared/windows-retry-file-operations'
import { writeRollingFileBackup } from '../../../filesystem/rolling-file-backup'
import {
  observeFilePublication,
  observedExistsSync as existsSync,
  observeFileReadError,
  observeResolvedFilePath
} from '../../../filesystem/file-content-observation'

export function writeTomlConfigAtomically(configPath: string, contents: string): void {
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
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    renameFileWithWindowsRetry(temporaryPath, writePath)
    observeFilePublication(writePath, contents)
    renamed = true
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
