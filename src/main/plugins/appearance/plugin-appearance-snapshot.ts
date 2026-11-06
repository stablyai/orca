import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureFile } from '../../../shared/secure-file'
import { pluginDataDir } from '../plugin-storage-store'
import { appearanceRestoreSchema } from './plugin-appearance-restore'

const colors = z.strictObject({ app: z.string().max(16384), terminal: z.string().max(16384) })
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dark: colors.optional(),
  light: colors.optional(),
  restore: appearanceRestoreSchema.optional()
})

/** One owner's last published colors per mode and what to restore when it stops. */
export type AppearanceSnapshot = z.infer<typeof snapshotSchema>

/** Where one owner's snapshot lives: its own data folder, never its installed code. */
export function appearanceSnapshotFile(pluginsDataDir: string, pluginKey: string): string {
  return join(pluginDataDir(pluginsDataDir, pluginKey), 'appearance.json')
}

/** The persisted snapshot, or null when none exists; throws when it is oversized or invalid. */
export function readAppearanceSnapshot(file: string): AppearanceSnapshot | null {
  if (!existsSync(file)) {
    return null
  }
  if (statSync(file).size > 256 * 1024) {
    throw new Error('appearance snapshot exceeds 256 KiB')
  }
  return snapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export function writeAppearanceSnapshot(file: string, state: AppearanceSnapshot): void {
  writeSecureFile(file, JSON.stringify(state))
}
