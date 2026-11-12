import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { readProfileStateDocuments } from './profile-state-document-reader'
import { readProfileStateRevision } from '../database/profile-state-revision'
import { openProfileStateDatabase } from '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openTestDatabase(): {
  directory: string
  db: ReturnType<typeof openProfileStateDatabase>['db']
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-documents-'))
  temporaryDirectories.push(directory)
  return {
    directory,
    db: openProfileStateDatabase(profileStateDatabaseFile(directory), 'profile-a').db
  }
}

describe('profile state document adapter', () => {
  it('rejects a stale complete-document replacement before deleting rows', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: true }))
      expect(() =>
        importProfileStateJson(db, JSON.stringify({ replacement: true }), {
          expectedRevision: 0
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'profile-state-revision-conflict',
          expectedRevision: 0,
          actualRevision: 1
        })
      )
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: true }))
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('rolls back every row and the revision when one insert fails', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: { value: 1 } }), { now: () => 10 })
      db.exec(
        `CREATE TRIGGER fail_profile_state_insert
         BEFORE INSERT ON profile_state_documents
         WHEN NEW.domain = 'second'
         BEGIN SELECT RAISE(ABORT, 'injected document failure'); END`
      )

      expect(() => importProfileStateJson(db, JSON.stringify({ first: 1, second: 2 }))).toThrow(
        'injected document failure'
      )
      db.exec('DROP TRIGGER fail_profile_state_insert')
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: { value: 1 } }))
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('does not roll back a transaction owned by the caller', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: true }))
      db.exec('BEGIN IMMEDIATE')

      expect(() => importProfileStateJson(db, JSON.stringify({ replacement: true }))).toThrow(
        'requires an idle database connection'
      )
      expect(db.isTransaction).toBe(true)
      db.exec('ROLLBACK')
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: true }))
    } finally {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      db.close()
    }
  })

  it('rejects a tampered payload when its hash no longer matches', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ ui: { active: 'terminal' } }))
      db.prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?').run(
        JSON.stringify({ active: 'tasks' }),
        'ui'
      )

      expect(() => readProfileStateDocuments(db)).toThrowError(
        expect.objectContaining({ domain: 'ui' })
      )
      expect(() => exportProfileStateJson(db)).toThrowError(/hash mismatch: ui/)
    } finally {
      db.close()
    }
  })
})
