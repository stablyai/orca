import { createHash } from 'node:crypto'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  isSettingsBackupSectionId,
  type SettingsBackupSectionId
} from '../../shared/settings-backup/settings-backup-catalog'
import {
  isPlainJsonValue,
  toCanonicalJson
} from '../../shared/settings-backup/settings-backup-canonical-json'
import {
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
  type SettingsBackupFile,
  type SettingsBackupInvalidReason
} from '../../shared/settings-backup/settings-backup-types'

/** Settings backups are small; anything larger is not one of ours and is refused before parsing. */
export const SETTINGS_BACKUP_MAX_BYTES = 5 * 1024 * 1024

const KNOWN_PLATFORMS: readonly NodeJS.Platform[] = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
]

export function buildSettingsBackupFile(args: {
  settings: Partial<GlobalSettings>
  sections: SettingsBackupSectionId[]
  appVersion: string
  platform: NodeJS.Platform
  now: Date
}): SettingsBackupFile {
  const body = {
    format: SETTINGS_BACKUP_FORMAT,
    formatVersion: SETTINGS_BACKUP_FORMAT_VERSION,
    createdAt: args.now.toISOString(),
    appVersion: args.appVersion,
    sourcePlatform: args.platform,
    sections: [...args.sections],
    settings: args.settings
  }
  return { ...body, integrity: { algorithm: 'sha256', digest: digestBody(body) } }
}

export function serializeSettingsBackupFile(file: SettingsBackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export type ParsedSettingsBackup =
  | {
      ok: true
      createdAt: string
      appVersion: string
      sourcePlatform: NodeJS.Platform
      sections: SettingsBackupSectionId[]
      settings: Record<string, unknown>
    }
  | { ok: false; reason: SettingsBackupInvalidReason }

/** Validates untrusted file text. The result is data only; nothing in it is executed or trusted. */
export function parseSettingsBackupFile(text: string): ParsedSettingsBackup {
  if (Buffer.byteLength(text, 'utf8') > SETTINGS_BACKUP_MAX_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  let parsed: unknown
  try {
    // Why: drop prototype-polluting keys at parse time so no later spread or merge can see them.
    parsed = JSON.parse(text.replace(/^﻿/, ''), (key: string, value: unknown) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value
    )
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (!isRecord(parsed) || parsed.format !== SETTINGS_BACKUP_FORMAT) {
    return { ok: false, reason: 'wrong-format' }
  }
  const { formatVersion, createdAt, appVersion, sourcePlatform, sections, settings, integrity } =
    parsed
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    return { ok: false, reason: 'wrong-format' }
  }
  if (formatVersion > SETTINGS_BACKUP_FORMAT_VERSION) {
    return { ok: false, reason: 'newer-format' }
  }
  if (
    typeof createdAt !== 'string' ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof appVersion !== 'string' ||
    !isKnownPlatform(sourcePlatform) ||
    !Array.isArray(sections) ||
    !sections.every(isSettingsBackupSectionId) ||
    !isRecord(settings) ||
    !isPlainJsonValue(settings) ||
    !isRecord(integrity) ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.digest !== 'string'
  ) {
    return { ok: false, reason: 'wrong-format' }
  }
  const expectedDigest = digestBody({
    format: SETTINGS_BACKUP_FORMAT,
    formatVersion,
    createdAt,
    appVersion,
    sourcePlatform,
    sections,
    settings
  })
  if (expectedDigest !== integrity.digest) {
    return { ok: false, reason: 'integrity-mismatch' }
  }
  return { ok: true, createdAt, appVersion, sourcePlatform, sections, settings }
}

function digestBody(body: Record<string, unknown>): string {
  return createHash('sha256').update(toCanonicalJson(body), 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownPlatform(value: unknown): value is NodeJS.Platform {
  return KNOWN_PLATFORMS.some((platform) => platform === value)
}
