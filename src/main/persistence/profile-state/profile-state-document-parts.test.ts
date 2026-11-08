import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportProfileStateJson,
  importProfileStateJson,
  readProfileStateRevision
} from './profile-state-documents'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import { refreshProfileStateLegacyDocuments } from './profile-state-legacy-document-refresh'
import { hashProfileStatePayload } from './profile-state-document-validation'
import { assignProfileStatePartOrdinals } from './profile-state-document-part-ordinals'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-parts-'))
  directories.push(directory)
  return openProfileStateDatabase(profileStateDatabaseFile(directory), 'profile-a').db
}

type Db = ReturnType<typeof open>

function write(db: Db, domains: Record<string, unknown>): number {
  return writeProfileStateDomains(db, {
    expectedRevision: readProfileStateRevision(db),
    replacements: Object.entries(domains).map(([domain, value]) => ({
      domain,
      payload: JSON.stringify(value)
    }))
  }).revision
}

function read(db: Db, domain: string): unknown {
  const result = readProfileStateDomainsWithRevisionFromDatabase(db, [domain])
  if (result.kind !== 'values') {
    throw result.error
  }
  return result.values.get(domain)
}

function partRows(db: Db) {
  return db
    .prepare(
      `SELECT part_key, ordinal, content_hash FROM profile_state_document_parts
       WHERE domain = 'workspaceSessionsByHostId' ORDER BY ordinal`
    )
    .all() as { part_key: string; ordinal: number; content_hash: string }[]
}

function legacyRow(db: Db, domain: string) {
  return db
    .prepare('SELECT payload, revision FROM profile_state_documents WHERE domain = ?')
    .get(domain) as { payload: string; revision: number }
}

const sessions = (scrollback: string, title = 'shell') => ({
  'runtime:a': {
    tabsByWorktree: { wt1: [{ id: 't1', title }], wt2: [{ id: 't2', title: 'b' }] },
    localOnlyScrollbackByTabId: { t1: { leaf: scrollback } },
    activeTabId: 't1'
  },
  'ssh:b': { tabsByWorktree: {} }
})

describe('profile state document parts', () => {
  it('reads back exactly what was written and rewrites only the entries that changed', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: sessions('x'.repeat(10_000)), other: 1 })
      const before = new Map(partRows(db).map((row) => [row.part_key, row]))

      write(db, { workspaceSessionsByHostId: sessions('x'.repeat(10_000), 'renamed') })

      expect(read(db, 'workspaceSessionsByHostId')).toEqual(sessions('x'.repeat(10_000), 'renamed'))
      const changed = partRows(db).filter(
        (row) => before.get(row.part_key)?.content_hash !== row.content_hash
      )
      expect(changed.map((row) => JSON.parse(row.part_key))).toEqual([
        ['runtime:a', 'tabsByWorktree', 'wt1']
      ])
      // Untouched rows keep their position, so nothing else is renumbered.
      for (const row of partRows(db)) {
        expect(row.ordinal).toBe(before.get(row.part_key)?.ordinal ?? row.ordinal)
      }
      expect(exportProfileStateJson(db)).toBe(
        JSON.stringify({
          workspaceSessionsByHostId: sessions('x'.repeat(10_000), 'renamed'),
          other: 1
        })
      )
    } finally {
      db.close()
    }
  })

  it('leaves the legacy row as a downgrade copy and refreshes it without a new revision', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: sessions('a') })
      write(db, { workspaceSessionsByHostId: sessions('b') })
      const revision = readProfileStateRevision(db)
      expect(JSON.parse(legacyRow(db, 'workspaceSessionsByHostId').payload)).toEqual(sessions('a'))

      expect(refreshProfileStateLegacyDocuments(db)).toBe(1)

      expect(JSON.parse(legacyRow(db, 'workspaceSessionsByHostId').payload)).toEqual(sessions('b'))
      expect(readProfileStateRevision(db)).toBe(revision)
      expect(read(db, 'workspaceSessionsByHostId')).toEqual(sessions('b'))
      expect(refreshProfileStateLegacyDocuments(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('trusts a legacy row an older build rewrote, then re-splits it on the next write', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: sessions('a') })
      write(db, { workspaceSessionsByHostId: sessions('b') })
      // An older build knows only profile_state_documents.
      const olderPayload = JSON.stringify(sessions('from older build'))
      const revision = readProfileStateRevision(db) + 1
      db.prepare(
        `UPDATE profile_state_documents SET payload = ?, content_hash = ?, revision = ?
         WHERE domain = 'workspaceSessionsByHostId'`
      ).run(olderPayload, hashProfileStatePayload(olderPayload), revision)
      db.prepare(`UPDATE profile_state_meta SET value = ? WHERE key = 'revision'`).run(
        String(revision)
      )

      expect(read(db, 'workspaceSessionsByHostId')).toEqual(sessions('from older build'))
      expect(refreshProfileStateLegacyDocuments(db)).toBe(0)

      write(db, { workspaceSessionsByHostId: sessions('c') })
      expect(read(db, 'workspaceSessionsByHostId')).toEqual(sessions('c'))
      expect(partRows(db).length).toBeGreaterThan(1)
    } finally {
      db.close()
    }
  })

  it('treats an import as authoritative and deletes with the domain', () => {
    const db = open()
    try {
      write(db, { workspaceSessionsByHostId: sessions('a') })
      importProfileStateJson(db, JSON.stringify({ workspaceSessionsByHostId: sessions('import') }))
      expect(read(db, 'workspaceSessionsByHostId')).toEqual(sessions('import'))
      expect(partRows(db)).toEqual([])

      write(db, { workspaceSessionsByHostId: sessions('d') })
      writeProfileStateDomains(db, {
        expectedRevision: readProfileStateRevision(db),
        replacements: [{ domain: 'workspaceSessionsByHostId', payload: null }]
      })
      expect(read(db, 'workspaceSessionsByHostId')).toBeUndefined()
      expect(partRows(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('stores non-canonical JSON as an ordinary row', () => {
    const db = open()
    try {
      const payload = '{ "runtime:a": {"activeTabId": "t1"} }'
      writeProfileStateDomains(db, {
        expectedRevision: 0,
        replacements: [{ domain: 'workspaceSessionsByHostId', payload }]
      })
      expect(partRows(db)).toEqual([])
      expect(exportProfileStateJson(db)).toBe(`{"workspaceSessionsByHostId":${payload}}`)
    } finally {
      db.close()
    }
  })
})

describe('profile state part ordinals', () => {
  const previous = new Map([
    ['a', 0],
    ['b', 1024],
    ['c', 2048],
    ['d', 3072]
  ])

  it('keeps every existing ordinal on insert, remove and single moves', () => {
    expect(assignProfileStatePartOrdinals(['a', 'x', 'b', 'c', 'd'], previous)).toEqual([
      0, 512, 1024, 2048, 3072
    ])
    expect(assignProfileStatePartOrdinals(['a', 'c', 'd'], previous)).toEqual([0, 2048, 3072])
    const moved = assignProfileStatePartOrdinals(['d', 'a', 'b', 'c'], previous)
    expect(moved.slice(1)).toEqual([0, 1024, 2048])
    expect(moved[0]).toBeLessThan(0)
  })

  it('stays strictly increasing when gaps run out', () => {
    const tight = new Map([
      ['a', 0],
      ['b', 1]
    ])
    const ordinals = assignProfileStatePartOrdinals(['a', 'x', 'y', 'b'], tight)
    expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right))
    expect(new Set(ordinals).size).toBe(4)
  })
})
