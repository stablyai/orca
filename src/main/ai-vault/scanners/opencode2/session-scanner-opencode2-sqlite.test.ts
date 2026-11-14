import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'

import {
  parseOpenCode2SqliteSession,
  captureOpenCode2SqliteSession
} from './session-scanner-opencode2-sqlite'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(name = 'opencode-next.db'): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode2-sqlite-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  return { db: new Database(path), path }
}

function applyOpenCode2Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      fork_session_id TEXT,
      fork_boundary TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT,
      version TEXT NOT NULL,
      share_url TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

function insertSession(
  db: Database.Database,
  session: {
    id: string
    directory: string
    title?: string | null
    timeCreated: number
    timeUpdated: number
    parentId?: string | null
    timeArchived?: number | null
  }
): void {
  db.prepare(
    `INSERT INTO session_v2
      (id, project_id, parent_id, slug, directory, title, version, model, agent, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    'project_1',
    session.parentId ?? null,
    'slug',
    session.directory,
    session.title ?? null,
    '0.0.0-next-1',
    null,
    null,
    session.timeCreated,
    session.timeUpdated,
    session.timeArchived ?? null
  )
}

function insertMessage(
  db: Database.Database,
  message: {
    id: string
    sessionId: string
    type: string
    seq: number
    timeCreated: number
    data: string
  }
): void {
  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    message.id,
    message.sessionId,
    message.type,
    message.seq,
    message.timeCreated,
    message.timeCreated,
    message.data
  )
}

it('captures the full transcript while keeping list previews bounded', async () => {
  const { db, path } = createTempDb('opencode.db')
  applyOpenCode2Schema(db)
  insertSession(db, { id: 'long', directory: '/repo', timeCreated: 1000, timeUpdated: 9000 })
  for (let index = 0; index < 8; index++) {
    insertMessage(db, {
      id: `message_${index}`,
      sessionId: 'long',
      type: 'user',
      seq: index,
      timeCreated: 1000 + index,
      data: JSON.stringify({ text: `Turn ${index}` })
    })
  }
  db.close()
  const args = { dbPath: path, sessionId: 'long', platform: 'darwin' as const }
  const preview = await parseOpenCode2SqliteSession(args)
  const capture = await captureOpenCode2SqliteSession(args)
  expect(preview?.previewMessages).toHaveLength(5)
  expect(capture.messages.map((message) => message.text)).toEqual(
    Array.from({ length: 8 }, (_, index) => `Turn ${index}`)
  )
})
