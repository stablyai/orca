import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSettingsBackupKeyClass } from '../../shared/settings-backup/settings-backup-catalog'
import { isPlainJsonValue } from '../../shared/settings-backup/settings-backup-canonical-json'
import type { SettingsRecoveryPointSummary } from '../../shared/settings-backup/settings-backup-types'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const SETTINGS_RECOVERY_POINT_DIR = 'settings-recovery-points'
export const SETTINGS_RECOVERY_POINT_LIMIT = 10

const RECOVERY_POINT_ID_PATTERN = /^[0-9]{13}-[0-9a-f-]{36}$/

type RecoveryPointReason = SettingsRecoveryPointSummary['reason']

type RecoveryPointFile = {
  id: string
  createdAt: string
  reason: RecoveryPointReason
  /** Values before the change, for exactly the keys the change touched. */
  settings: Record<string, unknown>
}

/**
 * Local undo history for imports. Only keys an import may touch are snapshotted, and those never
 * include protected secrets, so recovery points hold no credentials.
 */
export class SettingsRecoveryPointStore {
  constructor(private readonly userDataPath: string) {}

  private get directory(): string {
    return join(this.userDataPath, SETTINGS_RECOVERY_POINT_DIR)
  }

  async create(args: {
    current: GlobalSettings
    keys: readonly string[]
    reason: RecoveryPointReason
    now: Date
  }): Promise<SettingsRecoveryPointSummary> {
    const currentByKey = new Map<string, unknown>(Object.entries(args.current))
    const settings: Record<string, unknown> = {}
    for (const key of args.keys) {
      if (isRestorableKey(key)) {
        // Why: JSON drops undefined, so an absent optional key is recorded as null and restored as
        // null — every key the import touched comes back, not only the ones that had a value.
        settings[key] = structuredClone(currentByKey.get(key) ?? null)
      }
    }
    const id = `${args.now.getTime()}-${randomUUID()}`
    const file: RecoveryPointFile = {
      id,
      createdAt: args.now.toISOString(),
      reason: args.reason,
      settings
    }
    await mkdir(this.directory, { recursive: true })
    const finalPath = join(this.directory, `${id}.json`)
    await writeFileDurable(durableWriteTempPath(finalPath), finalPath, JSON.stringify(file))
    await this.prune()
    return summarize(file)
  }

  async list(): Promise<SettingsRecoveryPointSummary[]> {
    const files = await this.readAll()
    return files.map(summarize)
  }

  /** Returns the update that puts the recorded keys back, or null when the point is gone or unreadable. */
  async readUpdate(id: string): Promise<Partial<GlobalSettings> | null> {
    if (!RECOVERY_POINT_ID_PATTERN.test(id)) {
      return null
    }
    const file = await this.readOne(`${id}.json`)
    if (!file) {
      return null
    }
    const update: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(file.settings)) {
      if (isRestorableKey(key)) {
        update[key] = value === null ? undefined : value
      }
    }
    return update
  }

  private async prune(): Promise<void> {
    const files = await this.readAll()
    await Promise.all(
      files
        .slice(SETTINGS_RECOVERY_POINT_LIMIT)
        .map((file) => rm(join(this.directory, `${file.id}.json`), { force: true }))
    )
  }

  /** Newest first. */
  private async readAll(): Promise<RecoveryPointFile[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return []
    }
    const files = await Promise.all(
      names.filter((name) => name.endsWith('.json')).map((name) => this.readOne(name))
    )
    return files
      .filter((file): file is RecoveryPointFile => file !== null)
      .sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
  }

  private async readOne(name: string): Promise<RecoveryPointFile | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'))
      return isRecoveryPointFile(parsed) && `${parsed.id}.json` === name ? parsed : null
    } catch {
      return null
    }
  }
}

function isRestorableKey(key: string): boolean {
  const keyClass = getSettingsBackupKeyClass(key)
  return keyClass !== null && keyClass !== 'protected' && keyClass !== 'internal'
}

function summarize(file: RecoveryPointFile): SettingsRecoveryPointSummary {
  return {
    id: file.id,
    createdAt: file.createdAt,
    reason: file.reason,
    keyCount: Object.keys(file.settings).length
  }
}

function isRecoveryPointFile(value: unknown): value is RecoveryPointFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = new Map<string, unknown>(Object.entries(value))
  const id = record.get('id')
  const settings = record.get('settings')
  return (
    typeof id === 'string' &&
    RECOVERY_POINT_ID_PATTERN.test(id) &&
    typeof record.get('createdAt') === 'string' &&
    (record.get('reason') === 'before-import' || record.get('reason') === 'before-restore') &&
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    isPlainJsonValue(settings)
  )
}
