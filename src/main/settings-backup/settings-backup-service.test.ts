import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { buildSettingsBackupFile, serializeSettingsBackupFile } from './settings-backup-file'
import { SettingsBackupService, compareVersions } from './settings-backup-service'
import {
  SETTINGS_RECOVERY_POINT_LIMIT,
  SettingsRecoveryPointStore
} from './settings-recovery-points'

let dir: string
let settings: GlobalSettings
let clock: number

function createService(
  writeSettings?: (update: Partial<GlobalSettings>) => Promise<GlobalSettings>
) {
  return new SettingsBackupService({
    getSettings: () => settings,
    writeSettings:
      writeSettings ??
      (async (update) => {
        settings = { ...settings, ...update }
        return settings
      }),
    recoveryPoints: new SettingsRecoveryPointStore(join(dir, 'userData')),
    appVersion: '1.4.214',
    platform: 'linux',
    now: () => new Date((clock += 1000))
  })
}

async function writeBackup(name: string, backupSettings: Partial<GlobalSettings>): Promise<string> {
  const filePath = join(dir, name)
  const file = buildSettingsBackupFile({
    settings: backupSettings,
    sections: ['appearance', 'terminal'],
    appVersion: '1.4.214',
    platform: 'linux',
    now: new Date('2026-10-09T00:00:00.000Z')
  })
  await writeFile(filePath, serializeSettingsBackupFile(file))
  return filePath
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-settings-backup-'))
  settings = { ...getDefaultSettings('/home/tester'), theme: 'light', terminalFontSize: 13 }
  clock = Date.parse('2026-10-09T00:00:00.000Z')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsBackupService', () => {
  it('exports a file that imports back with the same values', async () => {
    settings = { ...settings, theme: 'dark', opencodeSessionCookie: 'secret-cookie' }
    const exportPath = join(dir, 'out.orca-settings.json')
    const service = createService()
    const exported = await service.exportToFile(
      { sections: ['appearance'] },
      async () => exportPath
    )
    expect(exported).toMatchObject({ status: 'saved', filePath: exportPath })
    const text = await readFile(exportPath, 'utf8')
    expect(text).not.toContain('secret-cookie')

    settings = { ...settings, theme: 'light' }
    const preview = await service.previewImport(async () => exportPath)
    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') {
      return
    }
    expect(preview.entries.map((entry) => entry.key)).toEqual(['theme'])
    const applied = await service.applyImport({ previewId: preview.previewId, keys: ['theme'] })
    expect(applied).toMatchObject({ status: 'applied', appliedKeys: ['theme'] })
    expect(settings.theme).toBe('dark')
  })

  it('leaves unselected settings untouched and records a recovery point first', async () => {
    const service = createService()
    const preview = await service.previewImport(() =>
      writeBackup('a.json', { theme: 'dark', terminalFontSize: 20 })
    )
    if (preview.status !== 'ready') {
      throw new Error('expected preview')
    }
    const result = await service.applyImport({ previewId: preview.previewId, keys: ['theme'] })
    expect(settings).toMatchObject({ theme: 'dark', terminalFontSize: 13 })
    if (result.status !== 'applied' || !result.recoveryPointId) {
      throw new Error('expected recovery point')
    }
    await service.restoreRecoveryPoint(result.recoveryPointId)
    expect(settings.theme).toBe('light')
  })

  it('rolls back when applying fails part-way', async () => {
    let calls = 0
    const service = createService(async (update) => {
      calls += 1
      settings = { ...settings, ...update }
      if (calls === 1) {
        throw new Error('side effect failed')
      }
      return settings
    })
    const preview = await service.previewImport(() => writeBackup('b.json', { theme: 'dark' }))
    if (preview.status !== 'ready') {
      throw new Error('expected preview')
    }
    const result = await service.applyImport({ previewId: preview.previewId, keys: ['theme'] })
    expect(result).toEqual({
      status: 'failed',
      message: expect.any(String),
      rolledBack: true
    })
    expect(settings.theme).toBe('light')
  })

  it('refuses a stale or forged preview id', async () => {
    const service = createService()
    expect(await service.applyImport({ previewId: 'made-up', keys: ['theme'] })).toEqual({
      status: 'expired'
    })
    const preview = await service.previewImport(() => writeBackup('c.json', { theme: 'dark' }))
    if (preview.status !== 'ready') {
      throw new Error('expected preview')
    }
    await service.applyImport({ previewId: preview.previewId, keys: [] })
    expect(await service.applyImport({ previewId: preview.previewId, keys: ['theme'] })).toEqual({
      status: 'expired'
    })
    expect(settings.theme).toBe('light')
  })

  it('reports a damaged file without changing anything', async () => {
    const filePath = await writeBackup('d.json', { theme: 'dark' })
    const text = await readFile(filePath, 'utf8')
    await writeFile(filePath, text.replace('"dark"', '"light"'))
    const writeSettings = vi.fn()
    const preview = await createService(writeSettings).previewImport(async () => filePath)
    expect(preview).toMatchObject({ status: 'invalid', reason: 'integrity-mismatch' })
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('treats a canceled dialog as a no-op', async () => {
    const service = createService()
    expect(await service.exportToFile({ sections: ['appearance'] }, async () => null)).toEqual({
      status: 'canceled'
    })
    expect(await service.previewImport(async () => null)).toEqual({ status: 'canceled' })
  })

  it('keeps a bounded number of recovery points', async () => {
    const store = new SettingsRecoveryPointStore(join(dir, 'userData'))
    for (let index = 0; index < SETTINGS_RECOVERY_POINT_LIMIT + 3; index += 1) {
      await store.create({
        current: settings,
        keys: ['theme'],
        reason: 'before-import',
        now: new Date((clock += 1000))
      })
    }
    expect(await store.list()).toHaveLength(SETTINGS_RECOVERY_POINT_LIMIT)
  })

  it('never snapshots protected keys into a recovery point', async () => {
    const store = new SettingsRecoveryPointStore(join(dir, 'userData'))
    settings = { ...settings, opencodeSessionCookie: 'secret-cookie' }
    const point = await store.create({
      current: settings,
      keys: ['theme', 'opencodeSessionCookie'],
      reason: 'before-import',
      now: new Date(clock)
    })
    expect(point.keyCount).toBe(1)
    const raw = await readFile(
      join(dir, 'userData', 'settings-recovery-points', `${point.id}.json`),
      'utf8'
    )
    expect(raw).not.toContain('secret-cookie')
  })
})

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('1.4.214', '1.4.214')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.4.2-beta', '1.4.3')).toBe(-1)
  })
})
