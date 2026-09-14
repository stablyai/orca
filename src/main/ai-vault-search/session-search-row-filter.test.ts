import { afterEach, describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchFilters } from './session-search-engine-types'
import { cwdKey } from './session-search-file-records'
import { sessionRowFilter } from './session-search-row-filter'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'

let index: SessionSearchIndexFile | null = null

afterEach(async () => {
  await index?.close()
  index = null
})

async function openIndex(): Promise<SyncDatabase> {
  index = await openSessionSearchIndexFile('ss-row-filter')
  return index.db
}

function addSession(
  db: SyncDatabase,
  id: number,
  cwd: string | null,
  overrides: { agent?: string; updatedAt?: string } = {}
): void {
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,updated_at,resume_command)
     VALUES (?,?,?,?,'fixture',?,?,?,'')`
  ).run(
    id,
    overrides.agent ?? 'claude',
    String(id),
    `/synthetic/${id}`,
    cwd,
    cwdKey(cwd),
    overrides.updatedAt ?? '2026-09-01T00:00:00.000Z'
  )
}

function selected(db: SyncDatabase, filters: SessionSearchFilters = {}): number[] {
  const filter = sessionRowFilter(filters)
  const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(' AND ')}` : ''
  return (
    db.prepare(`SELECT id FROM sessions ${where} ORDER BY id`).all(...filter.values) as {
      id: number
    }[]
  ).map((row) => row.id)
}

describe('a cwd scope is the sidebar key, or anything below it', () => {
  it.each([
    ['C:\\Work\\App', 'c:/work/app', true],
    ['C:\\Work\\App\\src', 'c:/work/app', true],
    ['/work/APP/src', '/work/app', false],
    ['/work/caf\u00e9', '/work/cafe\u0301', true],
    ['/work/app-other', '/work/app', false],
    ['/work/a_b/src', '/work/a_b', true],
    ['/work/axb/src', '/work/a_b', false],
    // Roots: `/` is the one key that is already a separator, which is where a
    // range bound is easiest to get wrong. A Windows key is not under POSIX `/`.
    ['/', '/', true],
    ['/work/app', '/', true],
    ['C:\\Work\\App', '/', false],
    ['C:\\', 'C:\\', true],
    ['C:\\Work\\App', 'C:\\', true]
  ])('scopes %s under %s: %s', async (cwd, scope, expected) => {
    const db = await openIndex()
    addSession(db, 1, cwd)
    expect(selected(db, { scopePaths: [scope] })).toEqual(expected ? [1] : [])
  })

  it('never matches a session whose transcript recorded no cwd', async () => {
    const db = await openIndex()
    addSession(db, 1, null)
    expect(selected(db, { scopePaths: ['/work'] })).toEqual([])
    expect(selected(db)).toEqual([1])
  })

  it('narrows to nothing when no scope the caller gave could be keyed', async () => {
    // `cwdKey` returns null for a scope it cannot key, and a scope that matches
    // nothing must return nothing; dropping it would answer the whole index.
    const db = await openIndex()
    addSession(db, 1, '/work/app')
    addSession(db, 2, '/elsewhere')
    expect(selected(db, { scopePaths: [''] })).toEqual([])
    expect(selected(db, { scopePaths: ['', '/work/app'] })).toEqual([1])
  })

  it('keeps a WSL UNC workspace distinct from the bare Linux spelling', async () => {
    // PR 2 decided cwd_key does not qualify a Linux path with its distro: the
    // collision is real but every SSH host has it too, and the fix is a column
    // naming the execution host, not a key only some hosts spell differently.
    const db = await openIndex()
    addSession(db, 1, '\\\\wsl.localhost\\Ubuntu\\home\\ada\\app')
    addSession(db, 2, '/home/ada/app')
    expect(selected(db, { scopePaths: ['\\\\wsl$\\Ubuntu\\home\\ada'] })).toEqual([1])
    expect(selected(db, { scopePaths: ['/home/ada/app'] })).toEqual([2])
    expect(selected(db, { scopePaths: ['\\\\wsl$\\Debian\\home\\ada\\app'] })).toEqual([])
  })
})

describe('caller filters', () => {
  it('narrows by agent, and by updated-at floor', async () => {
    const db = await openIndex()
    addSession(db, 1, '/work/app', { agent: 'claude', updatedAt: '2026-09-01T00:00:00.000Z' })
    addSession(db, 2, '/work/app', { agent: 'codex', updatedAt: '2026-09-05T00:00:00.000Z' })
    expect(selected(db, { agents: ['codex'] })).toEqual([2])
    expect(selected(db, { since: '2026-09-03T00:00:00.000Z' })).toEqual([2])
    expect(selected(db, { agents: ['claude'], since: '2026-09-03T00:00:00.000Z' })).toEqual([])
  })

  it('applies the retention cutoff through the files table', async () => {
    const db = await openIndex()
    addSession(db, 1, '/work/app')
    addSession(db, 2, '/work/app')
    db.prepare(
      "INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES ('a',0,100,1)"
    ).run()
    db.prepare(
      "INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES ('b',0,500,2)"
    ).run()
    const filter = sessionRowFilter({}, 300)
    const rows = db
      .prepare(`SELECT id FROM sessions WHERE ${filter.conditions.join(' AND ')}`)
      .all(...filter.values) as { id: number }[]
    expect(rows.map((row) => row.id)).toEqual([2])
  })
})

it('plans a cwd scope as a seek on sessions_cwd_key, never a scan', async () => {
  const db = await openIndex()
  const filter = sessionRowFilter({ scopePaths: ['/work/app'] })
  const plan = (
    db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE ${filter.conditions.join(' AND ')}`
      )
      .all(...filter.values) as { detail: string }[]
  ).map((row) => row.detail)

  expect(plan.join(' | ')).toContain('sessions_cwd_key')
  expect(plan.some((detail) => detail.startsWith('SEARCH'))).toBe(true)
  expect(plan.some((detail) => detail.startsWith('SCAN sessions'))).toBe(false)
})
