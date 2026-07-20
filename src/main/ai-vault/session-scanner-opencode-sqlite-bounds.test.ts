import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import Database from '../sqlite/sync-database'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'

// Part B (#8864) bounds: discovery reads only the newest session identities and
// recency fields, while the preview join reads parts of only the newest 100
// messages of a session. These tests pin the observable effects.

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-bounds-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      model TEXT,
      agent TEXT,
      cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

function insertSession(db: Database.Database, id: string, timeUpdated: number): void {
  db.prepare(
    `INSERT INTO session (id, project_id, directory, title, time_created, time_updated, agent)
     VALUES (?, 'proj', '/tmp/w', ?, ?, ?, 'build')`
  ).run(id, `Session ${id}`, timeUpdated - 1000, timeUpdated)
}

function insertUserMessage(
  db: Database.Database,
  args: { id: string; sessionId: string; timeCreated: number; text: string }
): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    args.id,
    args.sessionId,
    args.timeCreated,
    JSON.stringify({ role: 'user' })
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`
  ).run(
    `prt_${args.id}`,
    args.id,
    args.sessionId,
    args.timeCreated,
    JSON.stringify({ type: 'text', text: args.text })
  )
}

function insertMessageWithPart(
  db: Database.Database,
  args: {
    id: string
    sessionId: string
    timeCreated: number
    role: string
    partType: string
    text: string
  }
): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    args.id,
    args.sessionId,
    args.timeCreated,
    JSON.stringify({ role: args.role })
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`
  ).run(
    `prt_${args.id}`,
    args.id,
    args.sessionId,
    args.timeCreated,
    JSON.stringify({ type: args.partType, text: args.text })
  )
}

describe('listOpenCodeSqliteSessions — LIMIT-first discovery', () => {
  it('returns only the newest `limit` sessions by time_updated', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    for (let i = 0; i < 5; i++) {
      insertSession(db, `ses_${i}`, 1_777_634_000_000 + i * 1000)
    }
    db.close()

    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 2, issues: [] })
    expect(candidates.map((c) => c.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_4'),
      buildOpenCodeSqliteCandidatePath(path, 'ses_3')
    ])
  })

  it('uses time_created recency when time_updated is not positive', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertSession(db, 'ses_updated', 1_777_634_002_000)
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, time_created, time_updated, agent)
       VALUES ('ses_created', 'proj', '/tmp/w', 'Created fallback', ?, 0, 'build')`
    ).run(1_777_634_003_000)
    db.close()

    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 1, issues: [] })
    expect(candidates.map((candidate) => candidate.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_created')
    ])
    expect(candidates[0].file.mtimeMs).toBe(1_777_634_003_000)
  })

  it('does not read message payloads that discovery does not use', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertSession(db, 'ses_candidate', 1_777_634_001_000)
    db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
      'msg_malformed',
      'ses_candidate',
      1_777_634_000_500,
      'malformed JSON'
    )
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 10, issues })
    expect(candidates.map((candidate) => candidate.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_candidate')
    ])
    expect(issues).toEqual([])
  })
})

describe('parseOpenCodeSqliteSession — bounded preview window', () => {
  it('surfaces the newest text previews and retains the full message count', async () => {
    // Positive coverage of preview selection (newest OPENCODE_SQLITE_PREVIEW_LIMIT
    // by recency) + full-count retention. The window bound itself is pinned by the
    // discriminating test below (this all-text fixture would pass either way).
    const { db, path } = createTempDb()
    applySchema(db)
    const base = 1_777_634_000_000
    insertSession(db, 'ses_big', base + 200_000)

    for (let i = 0; i < 105; i++) {
      insertUserMessage(db, {
        id: `msg_${String(i).padStart(3, '0')}`,
        sessionId: 'ses_big',
        timeCreated: base + i * 100,
        text: i === 0 ? 'OLDEST_PROMPT' : `recent text ${i}`
      })
    }
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_big',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    // Full user/assistant count is retained for display accuracy.
    expect(session!.messageCount).toBe(105)
    // The preview surfaces the newest text parts only.
    expect(session!.previewMessages).toHaveLength(5)
    const previewText = session!.previewMessages.map((m) => m.text)
    expect(previewText).not.toContain('OLDEST_PROMPT')
    expect(previewText).toContain('recent text 104')
  })

  it('excludes user text whose message falls outside the newest-100 window', async () => {
    // Discriminating fixture: the newest 100 messages carry only non-text parts,
    // so the window yields zero previews; the user text lives in older messages
    // beyond the window. The pre-fix whole-session scan would surface that old
    // text, so this fails if the 100-message window is reverted.
    const { db, path } = createTempDb()
    applySchema(db)
    const base = 1_777_634_000_000
    insertSession(db, 'ses_window', base + 500_000)

    // Older-than-window user messages with real text parts.
    for (let i = 0; i < 3; i++) {
      insertMessageWithPart(db, {
        id: `old_${i}`,
        sessionId: 'ses_window',
        timeCreated: base + i * 100,
        role: 'user',
        partType: 'text',
        text: `OLD_USER_TEXT_${i}`
      })
    }
    // 100 newer assistant messages whose only part is non-text (tool output), so
    // they fill the newest-100 window but contribute no preview text.
    for (let i = 0; i < 100; i++) {
      insertMessageWithPart(db, {
        id: `new_${String(i).padStart(3, '0')}`,
        sessionId: 'ses_window',
        timeCreated: base + 10_000 + i * 100,
        role: 'assistant',
        partType: 'tool',
        text: `tool output ${i}`
      })
    }
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_window',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    // Full user/assistant count is retained (3 user + 100 assistant).
    expect(session!.messageCount).toBe(103)
    // The window excludes the old user text; the newest 100 have no text parts.
    expect(session!.previewMessages).toHaveLength(0)
    expect(session!.previewMessages.map((m) => m.text)).not.toContain('OLD_USER_TEXT_0')
  })

  it('counts only user/assistant messages, ignoring tool/system rows', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertSession(db, 'ses_roles', 1_777_634_100_000)
    insertUserMessage(db, {
      id: 'msg_user',
      sessionId: 'ses_roles',
      timeCreated: 1_777_634_000_100,
      text: 'hello'
    })
    // A tool-role message must not inflate the count.
    db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
      'msg_tool',
      'ses_roles',
      1_777_634_000_200,
      JSON.stringify({ role: 'tool' })
    )
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_roles',
      platform: 'darwin'
    })
    expect(session!.messageCount).toBe(1)
  })
})
