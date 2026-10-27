import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  DEFAULT_SETTINGS_BACKUP_SECTIONS,
  isSettingsBackupSectionId,
  type SettingsBackupSectionId
} from '../../shared/settings-backup/settings-backup-catalog'
import {
  buildSettingsBackupUpdate,
  diffSettingsBackup,
  projectSettingsForBackup
} from '../../shared/settings-backup/settings-backup-projection'
import type {
  SettingsBackupApplyRequest,
  SettingsBackupApplyResult,
  SettingsBackupDiffEntry,
  SettingsBackupExportRequest,
  SettingsBackupExportResult,
  SettingsBackupImportPreview,
  SettingsBackupInvalidReason,
  SettingsRecoveryRestoreResult
} from '../../shared/settings-backup/settings-backup-types'
import {
  SETTINGS_BACKUP_MAX_BYTES,
  buildSettingsBackupFile,
  parseSettingsBackupFile,
  serializeSettingsBackupFile
} from './settings-backup-file'
import type { SettingsRecoveryPointStore } from './settings-recovery-points'

/** A pending import review expires so a stale preview cannot be applied over newer settings. */
const PREVIEW_TTL_MS = 30 * 60 * 1000

export type SettingsBackupServiceDeps = {
  getSettings: () => GlobalSettings
  /** Same sanitizing write path the Settings UI uses, so imports get identical normalization. */
  writeSettings: (update: Partial<GlobalSettings>) => Promise<GlobalSettings>
  recoveryPoints: SettingsRecoveryPointStore
  appVersion: string
  platform: NodeJS.Platform
  now: () => Date
}

export type ChooseBackupSavePath = (defaultFileName: string) => Promise<string | null>
export type ChooseBackupOpenPath = () => Promise<string | null>

type PendingPreview = { entries: SettingsBackupDiffEntry[]; expiresAt: number }

export class SettingsBackupService {
  private pending: { id: string; preview: PendingPreview } | null = null

  constructor(private readonly deps: SettingsBackupServiceDeps) {}

  async exportToFile(
    request: SettingsBackupExportRequest,
    chooseSavePath: ChooseBackupSavePath
  ): Promise<SettingsBackupExportResult> {
    const sections = normalizeSections(request?.sections)
    if (sections.length === 0) {
      return { status: 'failed', message: 'Choose at least one group of settings to export.' }
    }
    const filePath = await chooseSavePath(defaultBackupFileName(this.deps.now()))
    if (!filePath) {
      return { status: 'canceled' }
    }
    try {
      const projection = projectSettingsForBackup(this.deps.getSettings(), sections)
      const file = buildSettingsBackupFile({
        settings: projection.settings,
        sections,
        appVersion: this.deps.appVersion,
        platform: this.deps.platform,
        now: this.deps.now()
      })
      await writeFile(filePath, serializeSettingsBackupFile(file), 'utf8')
      return {
        status: 'saved',
        filePath,
        exportedKeyCount: Object.keys(projection.settings).length,
        excludedSecretKeys: projection.excludedSecretKeys
      }
    } catch {
      // Why: fs errors can embed the full path; keep the message generic so nothing local leaks into logs.
      return { status: 'failed', message: 'The backup file could not be written.' }
    }
  }

  async previewImport(chooseOpenPath: ChooseBackupOpenPath): Promise<SettingsBackupImportPreview> {
    const filePath = await chooseOpenPath()
    if (!filePath) {
      return { status: 'canceled' }
    }
    let text: string
    try {
      if ((await stat(filePath)).size > SETTINGS_BACKUP_MAX_BYTES) {
        return invalid('too-large')
      }
      text = await readFile(filePath, 'utf8')
    } catch {
      return invalid('unreadable')
    }
    const parsed = parseSettingsBackupFile(text)
    if (!parsed.ok) {
      return invalid(parsed.reason)
    }
    const diff = diffSettingsBackup({
      current: this.deps.getSettings(),
      incoming: parsed.settings,
      sourcePlatform: parsed.sourcePlatform,
      currentPlatform: this.deps.platform
    })
    const previewId = randomUUID()
    this.pending = {
      id: previewId,
      preview: { entries: diff.entries, expiresAt: this.deps.now().getTime() + PREVIEW_TTL_MS }
    }
    const versionOrder = compareVersions(parsed.appVersion, this.deps.appVersion)
    return {
      status: 'ready',
      previewId,
      fileName: basename(filePath),
      createdAt: parsed.createdAt,
      appVersion: parsed.appVersion,
      sourcePlatform: parsed.sourcePlatform,
      sameAppVersion: versionOrder === 0,
      newerAppVersion: versionOrder > 0,
      sections: parsed.sections,
      entries: diff.entries,
      unchangedKeyCount: diff.unchangedKeyCount
    }
  }

  async applyImport(request: SettingsBackupApplyRequest): Promise<SettingsBackupApplyResult> {
    const pending = this.pending
    if (
      !pending ||
      pending.id !== request?.previewId ||
      pending.preview.expiresAt < this.deps.now().getTime()
    ) {
      return { status: 'expired' }
    }
    this.pending = null
    const keys = Array.isArray(request.keys)
      ? request.keys.filter((key): key is string => typeof key === 'string')
      : []
    const update = buildSettingsBackupUpdate(pending.preview.entries, keys)
    const appliedKeys = Object.keys(update)
    if (appliedKeys.length === 0) {
      return { status: 'applied', appliedKeys, recoveryPointId: null }
    }
    let recoveryPointId: string
    try {
      const point = await this.deps.recoveryPoints.create({
        current: this.deps.getSettings(),
        keys: appliedKeys,
        reason: 'before-import',
        now: this.deps.now()
      })
      recoveryPointId = point.id
    } catch {
      // Why: never change settings without a way back; a failed snapshot aborts the import untouched.
      return {
        status: 'failed',
        message: 'A recovery point could not be saved, so nothing was changed.',
        rolledBack: false
      }
    }
    try {
      await this.deps.writeSettings(update)
      return { status: 'applied', appliedKeys, recoveryPointId }
    } catch {
      const rolledBack = await this.rollBack(recoveryPointId)
      return { status: 'failed', message: 'The settings could not be applied.', rolledBack }
    }
  }

  listRecoveryPoints(): ReturnType<SettingsRecoveryPointStore['list']> {
    return this.deps.recoveryPoints.list()
  }

  async restoreRecoveryPoint(id: unknown): Promise<SettingsRecoveryRestoreResult> {
    if (typeof id !== 'string') {
      return { status: 'not-found' }
    }
    const update = await this.deps.recoveryPoints.readUpdate(id)
    if (!update) {
      return { status: 'not-found' }
    }
    const restoredKeys = Object.keys(update)
    try {
      // Why: restoring is itself undoable, so the settings it replaces get their own point first.
      await this.deps.recoveryPoints.create({
        current: this.deps.getSettings(),
        keys: restoredKeys,
        reason: 'before-restore',
        now: this.deps.now()
      })
      await this.deps.writeSettings(update)
      return { status: 'restored', restoredKeys }
    } catch {
      return { status: 'failed', message: 'The recovery point could not be restored.' }
    }
  }

  private async rollBack(recoveryPointId: string): Promise<boolean> {
    try {
      const update = await this.deps.recoveryPoints.readUpdate(recoveryPointId)
      if (!update) {
        return false
      }
      await this.deps.writeSettings(update)
      return true
    } catch {
      return false
    }
  }
}

function normalizeSections(value: unknown): SettingsBackupSectionId[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SETTINGS_BACKUP_SECTIONS]
  }
  return [...new Set(value.filter(isSettingsBackupSectionId))]
}

function invalid(reason: SettingsBackupInvalidReason): SettingsBackupImportPreview {
  return { status: 'invalid', reason, message: INVALID_MESSAGES[reason] }
}

const INVALID_MESSAGES: Record<SettingsBackupInvalidReason, string> = {
  unreadable: 'The file could not be read.',
  'too-large': 'The file is too large to be an Orca settings backup.',
  'not-json': 'The file is not valid JSON.',
  'wrong-format': 'The file is not an Orca settings backup.',
  'newer-format': 'The backup was made by a newer version of Orca. Update Orca and try again.',
  'integrity-mismatch': 'The backup is damaged or was edited after it was created.'
}

export function defaultBackupFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '')
  return `orca-settings-${stamp}.orca-settings.json`
}

/** Numeric dotted-version compare; prerelease suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string): number[] =>
    version
      .split(/[-+]/, 1)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}
