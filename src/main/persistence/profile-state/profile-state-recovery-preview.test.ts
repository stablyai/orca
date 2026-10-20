import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import { openProfileStateDatabase } from './profile-state-database'
import { importProfileStateJson } from './profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { previewProfileStateRollback } from './profile-state-recovery-preview'
import type { ProfileStateExportsResult } from '../../../shared/profile-state-recovery-command'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-preview-'))
  const directory = join(root, 'profiles', 'preview-test')
  mkdirSync(directory, { recursive: true })
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const opened = openProfileStateDatabase(databaseFile, 'preview-test')
  importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' }, ui: { x: 1 } }))
  return { root, opened, databaseFile, dataFile }
}

describe('previewProfileStateRollback', () => {
  it('reports domains lost / changed / added for a SQLite backup', async () => {
    const { root, opened, databaseFile, dataFile } = fixture()
    try {
      // Advance to revision 2, adding a new domain and changing one.
      importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'light' }, ui: { x: 2 }, repos: { a: 1 } }))
      const backupId = createProfileStateDatabaseBackupId()
      const backupPath = profileStateDatabaseBackupPath(databaseFile, backupId)
      await writeProfileStateDatabaseSnapshotAsync(opened.db, backupPath)

      const result: ProfileStateExportsResult = {
        profileId: 'preview-test',
        dataFile,
        databaseFile,
        exportPaths: [],
        backups: [{ id: backupId, path: backupPath, createdAtMs: Date.now() }]
      }
      const preview = previewProfileStateRollback(result, { kind: 'sqlite', backupId })
      expect(preview.targetRevision).toBe(2)
      // Backup has the same domains as the live DB right now, so no loss/add/change.
      expect(preview.diff.lost).toEqual([])
      expect(preview.diff.changed).toEqual([])
      expect(preview.diff.added).toEqual([])
    } finally {
      opened.db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a JSON export whose content is not a valid profile-state root', async () => {
    const { root, opened, databaseFile, dataFile } = fixture()
    try {
      const exportPath = profileStateJsonExportPath(dataFile, 2)
      writeFileSync(exportPath, '[1, 2, 3]')
      const result: ProfileStateExportsResult = {
        profileId: 'preview-test',
        dataFile,
        databaseFile,
        exportPaths: [exportPath],
        backups: []
      }
      expect(() => previewProfileStateRollback(result, { kind: 'json', revision: 2 })).toThrow(
        /invalid/
      )
    } finally {
      opened.db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
