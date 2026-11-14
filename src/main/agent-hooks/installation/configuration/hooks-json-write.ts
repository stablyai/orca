import {
  readObservedFileSync as readFileSync,
  observedExistsSync as existsSync
} from '../../../filesystem/file-content-observation'
import { mkdirSync, statSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'

import { dirname, join } from 'node:path'

import { randomUUID } from 'node:crypto'
import { resolveHooksJsonWritePath } from './hook-config-write-path'
import { writeRollingFileBackup } from '../../../filesystem/rolling-file-backup'
import { observeFilePublication } from '../../../filesystem/file-content-observation'

export function writeHooksJson(
  configPath: string,
  // Fallback serialization accepts provider-specific JSON shapes, including nested hooks.events.
  config: Record<string, unknown>,
  // JSONC callers supply edited text while retaining atomic writes and backups.
  options?: { preserveMode?: boolean; defaultMode?: number; serialized?: string }
): void {
  const writePath = resolveHooksJsonWritePath(configPath)
  const dir = dirname(writePath)
  mkdirSync(dir, { recursive: true })

  // Unique temp paths isolate concurrent writers and preserve the original on write failure.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  // Preserve owner-only permissions: agent configs can contain API keys.
  const existingMode =
    options?.preserveMode !== false && existsSync(writePath)
      ? statSync(writePath).mode & 0o777
      : options?.defaultMode

  // Identical reinstalls must not rotate away the last recoverable backup.
  if (existsSync(writePath)) {
    try {
      if (readFileSync(writePath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Retry through the write path after a failed read.
    }
  }

  try {
    // Windows read-only mode could prevent deleting a failed temporary write.
    const tmpMode = process.platform === 'win32' ? undefined : existingMode
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: tmpMode, flag: 'wx' })
    if (existingMode !== undefined && process.platform !== 'win32') {
      // Preserve requested permissions even with a stricter process umask.
      chmodSync(tmpPath, existingMode)
    }
    // Keep one prior version for recovery from a bad merge.
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    renameSync(tmpPath, writePath)
    observeFilePublication(writePath, serialized)
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
