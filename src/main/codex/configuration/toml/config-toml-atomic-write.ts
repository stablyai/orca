import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import '../../../filesystem/atomic-file-publication'
import { resolvesIntoWslShare } from '../../../wsl/filesystem/wsl-share-path-resolution'
import { renameFileWithWindowsRetry } from '../../../../shared/file-write/windows-retry-file-operations'
import { stageRollingFileBackup } from '../../../filesystem/rolling-file-backup'
import { assertGuardedFileCurrent } from '../../../filesystem/concurrent-file-edit-guard'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import {
  observeFilePublication,
  observedExistsSync as existsSync,
  observeFileReadError,
  observeResolvedFilePath
} from '../../../filesystem/file-content-observation'

/** The file's raw bytes (BOM kept), or null when it is definitely absent. */
export function readRawTomlConfig(configPath: string): string | null {
  try {
    return readFileSync(configPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/**
 * Returns false without publishing when the file no longer holds `computedFrom` (the raw bytes the
 * edit was made from, null for absent), so the caller redoes its edit instead of clobbering a newer save.
 */
export function writeTomlConfigAtomically(
  configPath: string,
  contents: string,
  computedFrom: string | null,
  options: { backup: boolean; refuseWslTarget?: boolean } = { backup: true }
): boolean {
  const writePath = resolveTomlWritePath(configPath)
  // The path can become a link into a WSL guest after the caller checked it; the caller retries.
  if (options.refuseWslTarget && resolvesIntoWslShare(writePath)) {
    return false
  }
  const directory = dirname(writePath)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(directory, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: 'utf-8',
      mode: resolveCodexConfigTomlFileMode(writePath)
    })
    // Checked before every rename attempt, so only the re-read is left between check and rename.
    const stillCurrent = (): boolean => {
      assertGuardedFileCurrent(writePath)
      return readRawTomlConfig(writePath) === computedFrom
    }
    if (!stillCurrent()) {
      return false
    }
    if (options.backup && existsSync(writePath)) {
      // Staged, then rotated only once the file is still current after the copy: a save that lands
      // while the copy is made refuses the update and keeps the previous backup.
      const backup = stageRollingFileBackup(writePath, `${writePath}.bak`)
      let current = false
      try {
        current = stillCurrent()
      } finally {
        if (!current) {
          backup.discard()
        }
      }
      if (!current) {
        return false
      }
      backup.commit()
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
