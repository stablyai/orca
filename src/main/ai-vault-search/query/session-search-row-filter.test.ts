import { afterEach, expect, it } from 'vitest'
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

it('matches under a thousand-plus scopes, past where an OR chain exceeds SQLite expression depth', async () => {
  const db = await openIndex()
  addSession(db, 1, '/lanes/lane-1199/src')
  addSession(db, 2, '/elsewhere')
  const scopePaths = Array.from({ length: 1_200 }, (_, index) => `/lanes/lane-${index}`)
  expect(selected(db, { scopePaths })).toEqual([1])
})
