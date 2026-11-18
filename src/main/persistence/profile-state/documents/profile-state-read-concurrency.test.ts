import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../database/profile-state-database'
import { verifyProfileStateSchema } from '../database/profile-state-database-validation'
import {
  importProfileStateJson,
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot
} from './profile-state-documents'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import * as revisions from '../database/profile-state-revision'

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
  it.each([
    ['read-only', openProfileStateDatabaseReadOnly],
    ['writable', openProfileStateDatabase]
  ] as const)(
    'opens a healthy %s database structurally and keeps its first full read consistent',
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
          // Why: opening checks structure only; automation content is read by ordinary reads.
          expect(committed).toBe(false)
          expect(readProfileStateParsedSnapshot(opened.db)).toEqual({
            revision: 1,
            state: { automationRuns: [{ id: 'run-1', status: 'pending' }] }
          })
          expect(committed).toBe(true)
          expect(opened.db.isTransaction).toBe(false)
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
})
