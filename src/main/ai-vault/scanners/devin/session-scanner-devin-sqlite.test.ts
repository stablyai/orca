import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { parseOpenCodeSqliteCaptureValue } from '../opencode/reader-transport/session-scanner-opencode-sqlite-worker-response'
import { devinDatabaseDiscoveries } from './session-scanner-devin-sources'
import {
  captureDevinSqliteSession,
  listDevinSqliteSessions,
  parseDevinSqliteSession
} from './session-scanner-devin-sqlite'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'

let root: string
let dbPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-devin-store-'))
  dbPath = join(root, 'sessions.db')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function openFixture(): Database {
  const writer = new Database(dbPath)
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
      workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE (session_id, node_id)
    );
  `)
  return writer
}

it('lists visible WAL sessions and captures only genuine turns on their main chain', async () => {
  const writer = openFixture()
  const cwd = join(root, 'project')
  try {
    const insert = writer.prepare(`INSERT INTO sessions
      (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden)
      VALUES (?, ?, 'cloud', 'devin-model', 'smart', 1767225600, 1767225660, 'WAL conversation', ?, ?)`)
    insert.run('visible', cwd, 3, 0)
    insert.run('hidden', cwd, 3, 1)
    const node = writer.prepare(`INSERT INTO message_nodes
      (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, 1767225620)`)
    node.run(
      'visible',
      0,
      null,
      JSON.stringify({ role: 'user', content: 'First prompt', metadata: { is_user_input: true } })
    )
    node.run('visible', 1, 0, JSON.stringify({ role: 'user', content: 'Generated context' }))
    node.run(
      'visible',
      2,
      1,
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'First answer' }] })
    )
    node.run(
      'visible',
      3,
      2,
      JSON.stringify({ role: 'user', content: 'Follow-up', metadata: { is_user_input: true } })
    )
    node.run('visible', 4, 0, JSON.stringify({ role: 'assistant', content: 'Inactive branch' }))
    node.run('hidden', 3, null, JSON.stringify({ role: 'assistant', content: 'Hidden session' }))

    const issues: AiVaultScanIssue[] = []
    const list = () => listDevinSqliteSessions({ dbPaths: [dbPath], limit: Infinity, issues })
    const first = await list()
    expect(first.map((candidate) => candidate.file.path)).toEqual([`${dbPath}#visible`])
    expect(issues).toEqual([])
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    const read = (sessionId: string) =>
      captureDevinSqliteSession({ dbPath, sessionId, platform: process.platform })
    expect(read('hidden')).toEqual({ session: null, messages: [] })
    const visible = read('visible')
    expect(visible.session).toMatchObject({
      title: 'WAL conversation',
      cwd,
      model: 'devin-model',
      messageCount: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z'
    })
    expect(visible.session?.resumeCommand).toContain('devin --resume')
    expect(visible.session?.previewMessages.map(({ text }) => text)).toEqual([
      'First prompt',
      'First answer',
      'Follow-up'
    ])
    expect(visible.messages.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'First prompt'],
      ['assistant', 'First answer'],
      ['user', 'Follow-up']
    ])

    writer.exec("BEGIN IMMEDIATE; UPDATE sessions SET main_chain_id = 4 WHERE id = 'visible'")
    expect(read('visible').messages.map(({ text }) => text)).toEqual([
      'First prompt',
      'First answer',
      'Follow-up'
    ])
    writer.exec('COMMIT')
    const branched = (await list())[0]?.file
    expect(branched).toMatchObject({ mtimeMs: 1767225660000 })
    expect(branched?.sizeBytes).not.toBe(first[0]?.file.sizeBytes)
    expect(read('visible').messages.map(({ text }) => text)).toEqual([
      'First prompt',
      'Inactive branch'
    ])
    writer
      .prepare(
        "UPDATE message_nodes SET chat_message = ? WHERE session_id = 'visible' AND node_id = 0"
      )
      .run(
        JSON.stringify({
          role: 'user',
          content: 'Edited prompt',
          metadata: { is_user_input: true }
        })
      )
    const replaced = (await list())[0]?.file
    expect(read('visible').messages.map(({ text }) => text)).toEqual([
      'Edited prompt',
      'Inactive branch'
    ])
    expect(replaced?.mtimeMs).toBe(branched?.mtimeMs)
    expect(replaced?.sizeBytes).not.toBe(branched?.sizeBytes)
    node.run('hidden', 4, 3, JSON.stringify({ role: 'assistant', content: 'Unrelated WAL write' }))
    expect((await list())[0]?.file.sizeBytes).toBe(replaced?.sizeBytes)
  } finally {
    writer.close()
  }
})

it('keeps a bounded preview but does not publish a partial capture for an oversized chain', () => {
  const writer = openFixture()
  try {
    writer.exec(`INSERT INTO sessions
      (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, main_chain_id)
      VALUES ('long', '/project', 'cloud', 'devin', 'smart', 1767225600, 1767225660, 20001);
      WITH RECURSIVE chain(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM chain WHERE id < 20001)
      INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
      SELECT 'long', id, CASE WHEN id > 1 THEN id-1 END,
        json_object('role', 'assistant', 'content', 'Turn ' || id), 1767225620 FROM chain;`)
    const args = { dbPath, sessionId: 'long', platform: process.platform }
    const preview = parseDevinSqliteSession(args)
    expect(preview?.previewMessagesTruncated).toBe(true)
    expect(preview?.previewMessages.at(-1)?.text).toBe('Turn 20001')
    expect(parseOpenCodeSqliteCaptureValue(captureDevinSqliteSession(args))).toEqual({
      session: preview,
      incomplete: true,
      messages: []
    })
  } finally {
    writer.close()
  }
})

it('leaves a missing database absent and emits no candidates for an empty schema fixture', async () => {
  const issues: AiVaultScanIssue[] = []
  const [missing] = await Promise.all(
    devinDatabaseDiscoveries(
      { devinTranscriptsDir: join(root, 'transcripts') },
      [],
      Infinity,
      issues
    )
  )
  expect(missing.files).toEqual([])
  expect(issues).toEqual([])
  expect(existsSync(dbPath)).toBe(false)

  const writer = openFixture()
  try {
    const list = () => listDevinSqliteSessions({ dbPaths: [dbPath], limit: Infinity, issues })
    expect(await list()).toEqual([])
    expect(issues).toEqual([])
    writer.exec('DROP TABLE message_nodes')
    expect(await list()).toEqual([])
    expect(issues).toMatchObject([{ path: dbPath, kind: 'scope' }])
  } finally {
    writer.close()
  }
})
