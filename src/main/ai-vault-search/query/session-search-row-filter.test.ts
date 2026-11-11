import { afterEach, describe, expect, it } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'
import type { SessionSearchFilters } from './session-search-engine-types'
import { cwdKey } from '../storage/session-search-file-records'
import { sessionRowFilter } from './session-search-row-filter'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'

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
  it('narrows to nothing when no scope the caller gave could be keyed', async () => {
    const db = await openIndex()
    addSession(db, 1, '/work/app')
    addSession(db, 2, '/elsewhere')
    expect(selected(db, { scopePaths: [''] })).toEqual([])
    expect(selected(db, { scopePaths: ['', '/work/app'] })).toEqual([1])
  })

  it('keeps a WSL UNC workspace distinct from the bare Linux spelling', async () => {
    const db = await openIndex()
    addSession(db, 1, '\\\\wsl.localhost\\Ubuntu\\home\\ada\\app')
    addSession(db, 2, '/home/ada/app')
    expect(selected(db, { scopePaths: ['\\\\wsl$\\Ubuntu\\home\\ada'] })).toEqual([1])
    expect(selected(db, { scopePaths: ['/home/ada/app'] })).toEqual([2])
    expect(selected(db, { scopePaths: ['\\\\wsl$\\Debian\\home\\ada\\app'] })).toEqual([])
  })
})

describe('caller filters', () => {
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

it('matches under a thousand-plus scopes, past where an OR chain exceeds SQLite expression depth', async () => {
  const db = await openIndex()
  addSession(db, 1, '/lanes/lane-1199/src')
  addSession(db, 2, '/elsewhere')
  const scopePaths = Array.from({ length: 1_200 }, (_, index) => `/lanes/lane-${index}`)
  expect(selected(db, { scopePaths })).toEqual([1])
})
