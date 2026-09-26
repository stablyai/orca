import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { verifyProfileStateSchema } from './profile-state-database-validation'
import {
  importProfileStateJson,
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot,
  validateProfileStateSnapshot
} from './profile-state-documents'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import * as revisions from './profile-state-revision'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-read-concurrency-'))
  directories.push(directory)
  const path = join(directory, 'profile-state.db')
  const { db } = openProfileStateDatabase(path, 'profile-a')
  importProfileStateJson(db, '{"automationRuns":[{"id":"run-1","status":"pending"}]}')
  return { path, db }
}

describe('profile state reads during concurrent commits', () => {
  it.each([readProfileStateSnapshot, readProfileStateParsedSnapshot, validateProfileStateSnapshot])(
    'keeps revision and documents together when a writer commits during %s',
    (read) => {
      const { path, db: writer } = fixture()
      const { db: reader } = openProfileStateDatabaseReadOnly(path, 'profile-a')
      const readRevision = revisions.readProfileStateRevision
      let committed = false
      vi.spyOn(revisions, 'readProfileStateRevision').mockImplementation((db) => {
        const revision = readRevision(db)
        if (db === reader && !committed) {
          committed = true
          writeProfileStateDomains(writer, {
            expectedRevision: 1,
            replacements: [{ domain: 'automationRuns', payload: '[]' }]
          })
        }
        return revision
      })
      try {
        const snapshot = read(reader)
        expect(committed).toBe(true)
        if (typeof snapshot === 'number') {
          expect(snapshot).toBe(1)
        } else {
          expect(snapshot).toMatchObject({ revision: 1 })
          expect(snapshot).toMatchObject(
            read === readProfileStateSnapshot
              ? { json: '{"automationRuns":[{"id":"run-1","status":"pending"}]}' }
              : { state: { automationRuns: [{ id: 'run-1', status: 'pending' }] } }
          )
        }
        expect(reader.isTransaction).toBe(false)
        const next = read(reader)
        expect(typeof next === 'number' ? next : next.revision).toBe(2)
      } finally {
        reader.close()
        writer.close()
      }
    }
  )

  it.each([
    ['read-only', openProfileStateDatabaseReadOnly],
    ['writable', openProfileStateDatabase]
  ] as const)(
    'opens a healthy %s database when automation state changes between validation reads',
    (_, open) => {
      const { path, db: writer } = fixture()
      const readRevision = revisions.readProfileStateRevision
      let committed = false
      vi.spyOn(revisions, 'readProfileStateRevision').mockImplementation((reader) => {
        const revision = readRevision(reader)
        if (reader !== writer && !committed) {
          committed = true
          writeProfileStateDomains(writer, {
            expectedRevision: 1,
            replacements: [{ domain: 'automationRuns', payload: '[]' }]
          })
        }
        return revision
      })
      try {
        const opened = open(path, 'profile-a')
        try {
          expect(committed).toBe(true)
          expect(opened.db.isTransaction).toBe(false)
          expect(readProfileStateParsedSnapshot(opened.db)).toEqual({
            revision: 2,
            state: { automationRuns: [] }
          })
          expect(readProfileStateSnapshot(opened.db)).toMatchObject({
            revision: 2,
            json: '{"automationRuns":[]}'
          })
        } finally {
          opened.db.close()
        }
      } finally {
        writer.close()
      }
    }
  )

  it('keeps caller-owned writes uncommitted through schema, full and selected reads', () => {
    const { db } = fixture()
    try {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run('probe', 'value')
      verifyProfileStateSchema(db, 'profile-a')
      expect(readProfileStateSnapshot(db).revision).toBe(1)
      expect(readProfileStateParsedSnapshot(db).revision).toBe(1)
      expect(readProfileStateDomainsWithRevisionFromDatabase(db, ['automationRuns'])).toEqual({
        kind: 'values',
        revision: 1,
        values: new Map([['automationRuns', [{ id: 'run-1', status: 'pending' }]]])
      })
      expect(db.isTransaction).toBe(true)
      db.exec('ROLLBACK')
      expect(
        db.prepare('SELECT value FROM profile_state_meta WHERE key = ?').get('probe')
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it.each(['owned', 'caller'] as const)(
    'preserves corrupt state and releases only %s read transactions',
    (ownership) => {
      const { db } = fixture()
      try {
        if (ownership === 'caller') {
          db.exec('BEGIN IMMEDIATE')
        }
        db.exec('DELETE FROM profile_state_automation_runs_meta')
        expect(() => verifyProfileStateSchema(db, 'profile-a')).toThrow('metadata is malformed')
        expect(() => readProfileStateSnapshot(db)).toThrow('metadata is malformed')
        expect(() => readProfileStateParsedSnapshot(db)).toThrow('metadata is malformed')
        expect(readProfileStateDomainsWithRevisionFromDatabase(db, ['automationRuns']).kind).toBe(
          'unreadable'
        )
        expect(db.isTransaction).toBe(ownership === 'caller')
        expect(db.prepare('SELECT domain FROM profile_state_automation_runs_meta').all()).toEqual(
          []
        )
        if (ownership === 'caller') {
          db.exec('ROLLBACK')
          expect(readProfileStateSnapshot(db).revision).toBe(1)
          expect(readProfileStateParsedSnapshot(db).revision).toBe(1)
        }
      } finally {
        db.close()
      }
    }
  )
})
