import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import { importProfileStateJson } from './profile-state-documents'
import { readProfileStateDocuments } from './profile-state-document-reader'
import { readProfileStateRevision } from './profile-state-revision'

const roots: string[] = []
const profileId = 'reader-salvage-test'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-reader-salvage-'))
  roots.push(root)
  const opened = openProfileStateDatabase(join(root, 'profile-state.db'), profileId)
  importProfileStateJson(opened.db, JSON.stringify({ settings: { theme: 'dark' }, ui: { x: 1 } }))
  // Leave the handle open so the caller mutates the same file.
  return { root, opened }
}
function close(root: string, opened: import('./profile-state-database').OpenProfileStateDatabase) {
  opened.db.close()
  rmSync(root, { recursive: true, force: true })
}

describe('salvage read mode', () => {
  it('skips a stale-hash row and keeps the intact one', () => {
    const { root, opened } = fixture()
    try {
      // Simulate a torn write: `settings` payload advanced past its stored hash.
      opened.db.exec(
        "UPDATE profile_state_documents SET payload = '{\"theme\":\"light\"}' WHERE domain = 'settings'"
      )
      const docs = readProfileStateDocuments(opened.db, {
        profileRevision: readProfileStateRevision(opened.db),
        representation: 'parsed',
        salvage: true
      })
      const domains = docs.map((d) => d.domain).sort()
      expect(domains).toEqual(['ui'])
    } finally {
      close(root, opened)
    }
  })

  it('throws the original corruption error when salvage is off', () => {
    const { root, opened } = fixture()
    try {
      opened.db.exec(
        "UPDATE profile_state_documents SET payload = '{\"theme\":\"light\"}' WHERE domain = 'settings'"
      )
      expect(() =>
        readProfileStateDocuments(opened.db, {
          profileRevision: readProfileStateRevision(opened.db),
          representation: 'parsed'
        })
      ).toThrow()
    } finally {
      close(root, opened)
    }
  })

  it('leaves a stale-hash row on disk (salvage is read-only, no in-place repair)', () => {
    const { root, opened } = fixture()
    try {
      opened.db.exec(
        "UPDATE profile_state_documents SET payload = '{\"theme\":\"light\"}' WHERE domain = 'settings'"
      )
      readProfileStateDocuments(opened.db, {
        profileRevision: readProfileStateRevision(opened.db),
        representation: 'parsed',
        salvage: true
      })
      // Salvage must not rewrite the row: the corrupt row stays excluded,
      // and recovery of that domain comes from a trusted snapshot/backup.
      const rows = opened.db
        .prepare('SELECT domain FROM profile_state_documents ORDER BY domain')
        .all()
        .map((r: { domain: string }) => r.domain)
      expect(rows).toEqual(['settings', 'ui'])
    } finally {
      close(root, opened)
    }
  })
})
