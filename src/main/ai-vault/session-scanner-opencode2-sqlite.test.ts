import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { listOpenCode2SqliteSessions } from './session-scanner-opencode2-sqlite-list'
import {
  parseOpenCode2SqliteSession,
  captureOpenCode2SqliteSession
} from './session-scanner-opencode2-sqlite'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

// Why: the opencode2 (beta) channel-scoped DB schema differs from v1 —
// `session_v2` rows plus `session_message` rows whose `data` holds tagged
// message JSON. These tests pin the defensive reads against that schema.

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

const issues: AiVaultScanIssue[] = []

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

it('keeps session metadata readable but refuses a complete capture when ordering columns are missing', async () => {
  const { db, path } = createTempDb()
  applyOpenCode2Schema(db)
  insertSession(db, { id: 'partial', directory: '/repo', timeCreated: 1000, timeUpdated: 1000 })
  db.exec('ALTER TABLE session_message DROP COLUMN seq')
  db.close()
  const args = { dbPath: path, sessionId: 'partial', platform: 'darwin' as const }
  expect((await parseOpenCode2SqliteSession(args))?.sessionId).toBe('partial')
  await expect(captureOpenCode2SqliteSession(args)).rejects.toThrow('schema is unreadable')
})

describe('listOpenCode2SqliteSessions', () => {
  it('lists top-level, non-archived sessions newest-first', async () => {
    const { db, path } = createTempDb()
    applyOpenCode2Schema(db)
    insertSession(db, {
      id: 'session_old',
      directory: '/repo',
      timeCreated: 1000,
      timeUpdated: 1000
    })
    insertSession(db, {
      id: 'session_new',
      directory: '/repo',
      timeCreated: 2000,
      timeUpdated: 2000
    })
    insertSession(db, {
      id: 'session_child',
      directory: '/repo',
      timeCreated: 3000,
      timeUpdated: 3000,
      parentId: 'session_new'
    })
    insertSession(db, {
      id: 'session_archived',
      directory: '/repo',
      timeCreated: 4000,
      timeUpdated: 4000,
      timeArchived: 5000
    })
    db.close()

    const candidates = await listOpenCode2SqliteSessions({
      dbPaths: [path],
      limit: 25,
      issues
    })

    expect(candidates.map((c) => c.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'session_new'),
      buildOpenCodeSqliteCandidatePath(path, 'session_old')
    ])
    expect(candidates[0]!.agent).toBe('opencode2')
  })

  it('skips databases without the session_v2 table', async () => {
    const { db, path } = createTempDb()
    db.exec(`CREATE TABLE unrelated (id TEXT PRIMARY KEY)`)
    db.close()

    const candidates = await listOpenCode2SqliteSessions({
      dbPaths: [path],
      limit: 25,
      issues
    })

    expect(candidates).toEqual([])
  })
})

describe('parseOpenCode2SqliteSession', () => {
  it('parses session metadata and preview messages', async () => {
    const { db, path } = createTempDb()
    applyOpenCode2Schema(db)
    insertSession(db, {
      id: 'session_1',
      directory: '/repo',
      title: 'Fix login',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    db.prepare(
      `UPDATE session_v2 SET model = ?, tokens_input = 10, tokens_output = 20, tokens_reasoning = 5, cost = 0.5 WHERE id = 'session_1'`
    ).run('{"id":"glm-5.2","providerID":"zai"}')
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'session_1',
      type: 'user',
      seq: 1,
      timeCreated: 1_777_634_000_500,
      data: JSON.stringify({
        id: 'msg_1',
        text: 'Add login flow',
        time: { created: 1_777_634_000_500 }
      })
    })
    insertMessage(db, {
      id: 'msg_2',
      sessionId: 'session_1',
      type: 'assistant',
      seq: 2,
      timeCreated: 1_777_634_000_900,
      data: JSON.stringify({
        id: 'msg_2',
        type: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        time: { created: 1_777_634_000_900 }
      })
    })
    db.close()

    const session = await withFullFirstUserPromptCapture(() =>
      parseOpenCode2SqliteSession({
        dbPath: path,
        sessionId: 'session_1',
        platform: 'darwin'
      })
    )

    expect(session).not.toBeNull()
    expect(session!.agent).toBe('opencode2')
    expect(session!.sessionId).toBe('session_1')
    expect(session!.filePath).toBe(path)
    expect(session!.title).toBe('Fix login')
    expect(session?.firstUserPrompt).toBe('Add login flow')
    expect(session!.cwd).toBe('/repo')
    expect(session!.model).toBe('glm-5.2')
    expect(session!.totalTokens).toBe(35)
    expect(session!.messageCount).toBe(2)
    expect(session!.previewMessages).toEqual([
      {
        role: 'user',
        text: 'Add login flow',
        timestamp: new Date(1_777_634_000_500).toISOString()
      },
      {
        role: 'assistant',
        text: 'Done.',
        timestamp: new Date(1_777_634_000_900).toISOString()
      }
    ])
    expect(session!.resumeCommand).toBe(
      "cd '/repo' && opencode2 --standalone --session 'session_1'"
    )
  })

  it('extracts assistant text from content arrays and falls back to raw model ids', async () => {
    const { db, path } = createTempDb()
    applyOpenCode2Schema(db)
    insertSession(db, {
      id: 'session_2',
      directory: '/repo',
      title: null,
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_000_000
    })
    db.prepare(`UPDATE session_v2 SET model = ? WHERE id = 'session_2'`).run(
      'anthropic/claude-sonnet'
    )
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'session_2',
      type: 'assistant',
      seq: 1,
      timeCreated: 1_777_634_000_500,
      data: JSON.stringify({
        id: 'msg_1',
        type: 'assistant',
        content: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'Visible answer' }
        ],
        time: { created: 1_777_634_000_500 }
      })
    })
    db.close()

    const session = await parseOpenCode2SqliteSession({
      dbPath: path,
      sessionId: 'session_2',
      platform: 'darwin'
    })

    expect(session).not.toBeNull()
    expect(session!.model).toBe('anthropic/claude-sonnet')
    expect(session!.previewMessages).toEqual([
      {
        role: 'assistant',
        text: 'Visible answer',
        timestamp: new Date(1_777_634_000_500).toISOString()
      }
    ])
  })

  it('fails soft when the session_v2 table is missing', async () => {
    const { db, path } = createTempDb()
    db.exec(`CREATE TABLE session_v1 (id TEXT PRIMARY KEY)`)
    db.close()

    const session = await parseOpenCode2SqliteSession({
      dbPath: path,
      sessionId: 'session_1',
      platform: 'darwin'
    })

    expect(session).toBeNull()
  })

  it('fails soft when the session does not exist', async () => {
    const { db, path } = createTempDb()
    applyOpenCode2Schema(db)
    db.close()

    const session = await parseOpenCode2SqliteSession({
      dbPath: path,
      sessionId: 'missing',
      platform: 'darwin'
    })

    expect(session).toBeNull()
  })
})
