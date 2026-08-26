import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { access, copyFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

function backupPath(dataFile: string, index: number): string {
  return `${dataFile}.bak.${index}`
}

/** existsSync's non-blocking twin: existsSync is an access(F_OK) probe, so access() is the exact analogue. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export function hasStateBackup(dataFile: string): boolean {
  for (let index = 0; index < BACKUP_COUNT; index += 1) {
    if (existsSync(backupPath(dataFile, index))) {
      return true
    }
  }
  return false
}

import type { StoreRuntimeState } from './store-runtime-state'

type BackupRecoveryRotationOperationsRuntime = Pick<StoreRuntimeState, 'backupRotationInFlight'>

export class BackupRecoveryRotationOperations {
  constructor(private readonly runtime: BackupRecoveryRotationOperationsRuntime) {}

  shouldRotateBackups(now: number, dataFile: string): boolean {
    try {
      const mtime = statSync(backupPath(dataFile, 0)).mtimeMs
      return now - mtime >= BACKUP_MIN_INTERVAL_MS
    } catch {
      return true
    }
  }

  async shouldRotateBackupsAsync(dataFile: string): Promise<boolean> {
    try {
      const mtime = (await stat(backupPath(dataFile, 0))).mtimeMs
      return Date.now() - mtime >= BACKUP_MIN_INTERVAL_MS
    } catch {
      return true
    }
  }

  async rotateBackupsAsync(dataFile: string): Promise<void> {
    if (this.runtime.backupRotationInFlight) {
      return
    }
    this.runtime.backupRotationInFlight = true
    try {
      if (!(await this.shouldRotateBackupsAsync(dataFile))) {
        return
      }
      if (!(await exists(dataFile))) {
        return
      }
      await rm(backupPath(dataFile, BACKUP_COUNT - 1)).catch((err: unknown) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[persistence] Failed to remove oldest backup:', err)
        }
      })
      for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
        const src = backupPath(dataFile, i)
        const dst = backupPath(dataFile, i + 1)
        // Why probe instead of rename-then-swallow-ENOENT: a degraded mount rejects a rename of an
        // absent slot with ESTALE/EIO, which would log once per empty slot on every debounced save.
        if (await exists(src)) {
          await rename(src, dst).catch((err) => {
            console.error('[persistence] Failed to rotate backup', src, '->', dst, err)
          })
        }
      }
      await copyFile(dataFile, backupPath(dataFile, 0)).catch((err) => {
        console.error('[persistence] Failed to snapshot current file to .bak.0:', err)
      })
    } finally {
      this.runtime.backupRotationInFlight = false
    }
  }

  rotateBackupsSync(dataFile: string): void {
    if (!existsSync(dataFile)) {
      return
    }
    try {
      unlinkSync(backupPath(dataFile, BACKUP_COUNT - 1))
    } catch (err) {
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[persistence] Failed to remove oldest backup:', err)
      }
    }
    for (let i = BACKUP_COUNT - 2; i >= 0; i--) {
      const src = backupPath(dataFile, i)
      const dst = backupPath(dataFile, i + 1)
      if (existsSync(src)) {
        try {
          renameSync(src, dst)
        } catch (err) {
          console.error('[persistence] Failed to rotate backup', src, '->', dst, err)
        }
      }
    }
    try {
      copyFileSync(dataFile, backupPath(dataFile, 0))
    } catch (err) {
      console.error('[persistence] Failed to snapshot current file to .bak.0:', err)
    }
  }

  restoreFromBackup(dataFile: string): boolean {
    for (let i = 0; i < BACKUP_COUNT; i++) {
      const path = backupPath(dataFile, i)
      if (!existsSync(path)) {
        continue
      }
      try {
        const raw = readFileSync(path, 'utf-8')
        JSON.parse(raw)
        mkdirSync(dirname(dataFile), { recursive: true })
        writeFileSync(dataFile, raw, 'utf-8')
        console.warn(`[persistence] Recovered state from backup slot ${i}: ${path}`)
        return true
      } catch (err) {
        console.error(`[persistence] Backup slot ${i} unusable, trying next:`, err)
      }
    }
    return false
  }
}
