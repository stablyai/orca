import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportProfileStateJson } from '../documents/profile-state-documents'
import { readProfileStateRevision } from '../database/profile-state-revision'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'
import { writeProfileStateDomains } from '../documents/profile-state-domain-writes'
import { readProfileStateDomainsWithRevisionFromDatabase } from '../documents/profile-state-domain-reader'
import { hashProfileStatePayload, isRecord } from '../documents/profile-state-document-validation'
import { writeProfileStateBackup } from '../backup/profile-state-backup-job'
import { ProfileStateSqliteAuthority } from '../profile-state-sqlite-authority'

const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-parts-'))
  directories.push(directory)
  return profileStateDatabaseFile(directory)
}

function open() {
  return openProfileStateDatabase(databasePath(), 'profile-a').db
}

type Db = ReturnType<typeof open>

function write(db: Db, domains: Record<string, string | null>): void {
  writeProfileStateDomains(db, {
    expectedRevision: readProfileStateRevision(db),
    replacements: Object.entries(domains).map(([domain, payload]) => ({ domain, payload }))
  })
}

function read(db: Db, domain: string): unknown {
  const result = readProfileStateDomainsWithRevisionFromDatabase(db, [domain])
  if (result.kind !== 'values') {
    throw result.error
  }
  return result.values.get(domain)
}

/** What a build without per-entry storage reads: only profile_state_documents. */
function readAsOlderBuild(path: string, domain: string): string {
  const { db } = openProfileStateDatabaseReadOnly(path, 'profile-a')
  try {
    const row: unknown = db
      .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
      .get(domain)
    return isRecord(row) && typeof row.payload === 'string' ? row.payload : ''
  } finally {
    db.close()
  }
}

const v1 =
  '{"runtime:a":{"tabsByWorktree":{"wt1":[{"id":"t1","title":"shell"}],"wt2":[{"id":"t2"}]},"activeTabId":"t1"},"ssh:b":{"tabsByWorktree":{}}}'
const v2 =
  '{"runtime:a":{"tabsByWorktree":{"wt2":[{"id":"t2"}],"wt3":[],"wt1":[{"id":"t1","title":"renamed"}]},"activeTabId":"t1"},"ssh:b":{"tabsByWorktree":{}}}'

describe('profile state document parts', () => {
  it('applies sparse patches, complete omissions and empty documents with a shared revision fence', () => {
    const db = open()
    try {
      const initial = writeProfileStateDomains(db, {
        expectedRevision: 0,
        replacements: [],
        complete: true,
        patches: [
          {
            domain: 'workspaceSession',
            operations: [{ kind: 'set', path: [], payload: '{"tabsByWorktree":{"a":[],"b":[]}}' }]
          }
        ]
      })
      expect(initial.revision).toBe(1)
      write(db, { workspaceSession: '{"tabsByWorktree":{"a":[],"b":[]}}', obsolete: '1' })
      const revision = readProfileStateRevision(db)
      const result = writeProfileStateDomains(db, {
        expectedRevision: revision,
        replacements: [],
        complete: true,
        patches: [{ domain: 'workspaceSession', operations: [] }]
      })
      expect(result.revision).toBe(revision + 1)
      expect(exportProfileStateJson(db)).toBe(
        '{"workspaceSession":{"tabsByWorktree":{"a":[],"b":[]}}}'
      )
      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: revision,
          replacements: [],
          patches: [{ domain: 'workspaceSession', operations: [] }]
        })
      ).toThrow('revision changed')
      writeProfileStateDomains(db, {
        expectedRevision: result.revision,
        replacements: [],
        patches: [
          { domain: 'workspaceSession', operations: [{ kind: 'set', path: [], payload: '{}' }] }
        ]
      })
      expect(exportProfileStateJson(db)).toBe('{"workspaceSession":{}}')
      writeProfileStateDomains(db, {
        expectedRevision: readProfileStateRevision(db),
        replacements: [],
        complete: true
      })
      expect(exportProfileStateJson(db)).toBe('{}')
    } finally {
      db.close()
    }
  })

  it('normalizes an unchanged legacy document through an empty patch', () => {
    const db = open()
    try {
      write(db, { workspaceSession: '{ "tabsByWorktree": { "a": [] } }' })
      writeProfileStateDomains(db, {
        expectedRevision: readProfileStateRevision(db),
        replacements: [],
        patches: [{ domain: 'workspaceSession', operations: [] }]
      })
      expect(exportProfileStateJson(db)).toBe('{"workspaceSession":{"tabsByWorktree":{"a":[]}}}')
    } finally {
      db.close()
    }
  })

  it('rejects a changed patch when an untouched part no longer matches the assembled hash', () => {
    const db = open()
    try {
      write(db, { workspaceSession: '{"tabsByWorktree":{"a":[],"b":[]}}' })
      db.prepare(`UPDATE profile_state_document_parts SET payload = ?, content_hash = ?
        WHERE domain = 'workspaceSession' AND part_key = ?`).run(
        '["corrupt"]',
        hashProfileStatePayload('["corrupt"]'),
        '["tabsByWorktree","b"]'
      )
      const revision = readProfileStateRevision(db)
      expect(
        writeProfileStateDomains(db, {
          expectedRevision: revision,
          replacements: [],
          patches: [{ domain: 'workspaceSession', operations: [] }]
        })
      ).toMatchObject({ changed: false, revision })
      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: revision,
          replacements: [],
          patches: [
            {
              domain: 'workspaceSession',
              operations: [{ kind: 'set', path: ['tabsByWorktree', 'a'], payload: '["changed"]' }]
            }
          ]
        })
      ).toThrow('parts hash mismatch')
      expect(readProfileStateRevision(db)).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('replaces a complete field prefix, normalizes incoming JSON and preserves omitted-field deletion', () => {
    const db = open()
    try {
      write(db, { workspaceSession: '{"tabsByWorktree":{"a":[],"b":[]},"activeTabId":"a"}' })
      const patch = (payload: string) =>
        writeProfileStateDomains(db, {
          expectedRevision: readProfileStateRevision(db),
          replacements: [],
          patches: [
            {
              domain: 'workspaceSession',
              operations: [{ kind: 'set', path: ['tabsByWorktree'], payload }]
            }
          ]
        })
      patch('{ "a": [ ], "b": [ "changed" ] }')
      expect(exportProfileStateJson(db)).toBe(
        '{"workspaceSession":{"tabsByWorktree":{"a":[],"b":["changed"]},"activeTabId":"a"}}'
      )
      patch('{"b":[]}')
      expect(exportProfileStateJson(db)).toBe(
        '{"workspaceSession":{"tabsByWorktree":{"b":[]},"activeTabId":"a"}}'
      )
    } finally {
      db.close()
    }
  })

  it.each(['a', 'b'])('does not conceal a corrupt %s row with a field replacement', (target) => {
    const db = open()
    try {
      write(db, { workspaceSession: '{"tabsByWorktree":{"a":[],"b":[]}}' })
      db.prepare(
        'UPDATE profile_state_document_parts SET payload = ? WHERE domain = ? AND part_key = ?'
      ).run('["corrupt"]', 'workspaceSession', JSON.stringify(['tabsByWorktree', target]))
      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: readProfileStateRevision(db),
          replacements: [],
          patches: [
            {
              domain: 'workspaceSession',
              operations: [{ kind: 'set', path: ['tabsByWorktree'], payload: '{"a":[],"b":[]}' }]
            }
          ]
        })
      ).toThrow('part is invalid')
    } finally {
      db.close()
    }
  })

  it('reads back the exact document after entries change, appear and move', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: v1, other: '1' })
      write(db, { workspaceSessionsByHostId: v2 })

      expect(exportProfileStateJson(db)).toBe(`{"workspaceSessionsByHostId":${v2},"other":1}`)
    } finally {
      db.close()
    }
  })

  it('gives an older build current state after a crash once the writer reopens', () => {
    const path = databasePath()
    openProfileStateDatabase(path, 'profile-a').db.close()
    const crashed = new ProfileStateSqliteAuthority(path, 'profile-a')
    crashed.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v1 }])
    crashed.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v2 }])
    // A crash never runs the graceful-close refresh.
    crashed.close()

    const reopened = new ProfileStateSqliteAuthority(path, 'profile-a')
    try {
      reopened.writeSerializedDomains([{ domain: 'other', payload: '1' }])
      expect(readAsOlderBuild(path, 'workspaceSessionsByHostId')).toBe(v2)
    } finally {
      reopened.close()
    }
  })

  it('trusts a document an older build rewrote, then keeps later writes', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: v1 })
      write(db, { workspaceSessionsByHostId: v2 })
      // An older build knows only profile_state_documents.
      const olderPayload = '{"runtime:a":{"activeTabId":"from-older-build"}}'
      const revision = readProfileStateRevision(db) + 1
      db.prepare(
        `UPDATE profile_state_documents SET payload = ?, content_hash = ?, revision = ?
         WHERE domain = 'workspaceSessionsByHostId'`
      ).run(olderPayload, hashProfileStatePayload(olderPayload), revision)
      db.prepare(`UPDATE profile_state_meta SET value = ? WHERE key = 'revision'`).run(
        String(revision)
      )

      expect(read(db, 'workspaceSessionsByHostId')).toEqual({
        'runtime:a': { activeTabId: 'from-older-build' }
      })

      write(db, { workspaceSessionsByHostId: v1 })
      write(db, { workspaceSessionsByHostId: v2 })
      expect(exportProfileStateJson(db)).toBe(`{"workspaceSessionsByHostId":${v2}}`)
    } finally {
      db.close()
    }
  })

  it('gives an older build current state after writes stop, without another write', () => {
    const path = databasePath()
    openProfileStateDatabase(path, 'profile-a').db.close()
    const first = new ProfileStateSqliteAuthority(path, 'profile-a')
    first.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v1 }])
    const revision = first.revision
    first.close()

    vi.useFakeTimers()
    const writer = new ProfileStateSqliteAuthority(path, 'profile-a')
    try {
      writer.initializeFromRevision(revision)
      writer.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v2 }])
      vi.advanceTimersByTime(60 * 60_000)
      expect(readAsOlderBuild(path, 'workspaceSessionsByHostId')).toBe(v2)
    } finally {
      writer.close()
    }
  })

  it('publishes backups whose older-build copy is current', async () => {
    const path = databasePath()
    openProfileStateDatabase(path, 'profile-a').db.close()
    const writer = new ProfileStateSqliteAuthority(path, 'profile-a')
    try {
      writer.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v1 }])
      writer.writeSerializedDomains([{ domain: 'workspaceSessionsByHostId', payload: v2 }])
      const backup = join(directories.at(-1)!, 'backup.db')
      await writeProfileStateBackup({
        databasePath: path,
        profileId: 'profile-a',
        targetPath: backup
      })
      expect(readAsOlderBuild(backup, 'workspaceSessionsByHostId')).toBe(v2)
    } finally {
      writer.close()
    }
  })
})
