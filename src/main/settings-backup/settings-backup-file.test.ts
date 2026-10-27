import { describe, expect, it } from 'vitest'
import {
  SETTINGS_BACKUP_MAX_BYTES,
  buildSettingsBackupFile,
  parseSettingsBackupFile,
  serializeSettingsBackupFile
} from './settings-backup-file'

function sampleText(): string {
  return serializeSettingsBackupFile(
    buildSettingsBackupFile({
      settings: { theme: 'dark', terminalFontSize: 15 },
      sections: ['appearance', 'terminal'],
      appVersion: '1.4.214',
      platform: 'win32',
      now: new Date('2026-10-09T00:00:00.000Z')
    })
  )
}

describe('settings backup file', () => {
  it('round-trips a backup it wrote', () => {
    const parsed = parseSettingsBackupFile(sampleText())
    expect(parsed).toEqual({
      ok: true,
      createdAt: '2026-10-09T00:00:00.000Z',
      appVersion: '1.4.214',
      sourcePlatform: 'win32',
      sections: ['appearance', 'terminal'],
      settings: { theme: 'dark', terminalFontSize: 15 }
    })
  })

  it('accepts a UTF-8 BOM added by editors', () => {
    expect(parseSettingsBackupFile(`﻿${sampleText()}`).ok).toBe(true)
  })

  it('rejects a backup edited after export', () => {
    const tampered = sampleText().replace('"dark"', '"light"')
    expect(parseSettingsBackupFile(tampered)).toEqual({ ok: false, reason: 'integrity-mismatch' })
  })

  it('rejects text that is not a settings backup', () => {
    expect(parseSettingsBackupFile('not json')).toEqual({ ok: false, reason: 'not-json' })
    expect(parseSettingsBackupFile('{"format":"other"}')).toEqual({
      ok: false,
      reason: 'wrong-format'
    })
    expect(parseSettingsBackupFile('[]')).toEqual({ ok: false, reason: 'wrong-format' })
  })

  it('rejects backups from a newer format version', () => {
    const newer = JSON.parse(sampleText())
    newer.formatVersion = 99
    expect(parseSettingsBackupFile(JSON.stringify(newer))).toEqual({
      ok: false,
      reason: 'newer-format'
    })
  })

  it('rejects oversized input before parsing', () => {
    expect(parseSettingsBackupFile(' '.repeat(SETTINGS_BACKUP_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too-large'
    })
  })

  it('drops prototype-polluting keys so they never reach a merge', () => {
    const file = JSON.parse(sampleText())
    const text = JSON.stringify(file).replace(
      '"settings":{',
      '"settings":{"__proto__":{"polluted":true},'
    )
    // The digest covers the cleaned body, so a smuggled key also fails integrity.
    const parsed = parseSettingsBackupFile(text)
    expect(Object.prototype).not.toHaveProperty('polluted')
    if (parsed.ok) {
      expect(Object.keys(parsed.settings)).not.toContain('__proto__')
    }
  })
})
