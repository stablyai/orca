import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  discoverDevinDbSessions,
  parseDevinDbSession,
  splitDevinDbSessionCandidate
} from './session-scanner-devin-db-sessions'

// Recorded from Devin 3000.11.205: a compaction's summary node names the chain it replaced.
const SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
    last_activity_at INTEGER, title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER,
    parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT);
`

let cliDir: string

beforeEach(async () => {
  cliDir = join(await mkdtemp(join(tmpdir(), 'orca-devin-db-sessions-')), 'devin', 'cli')
  await mkdir(join(cliDir, 'transcripts'), { recursive: true })
  const db = new SyncDatabase(join(cliDir, 'sessions.db'))
  db.exec(SCHEMA)
  const session = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
  session.run('acp-chat', '/work', 'swe-2', 1_777_000_300, 'Say hello', 9, 0)
  session.run('hidden-chat', '/work', 'swe-2', 1_777_000_200, 'Hidden', null, 1)
  session.run('tui-chat', '/work', 'swe-2', 1_777_000_100, 'Exported', null, 0)
  const node = db.prepare('INSERT INTO message_nodes VALUES (NULL, ?, ?, ?, ?, ?, ?)')
  const message = (role: string, content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ role, content, ...extra })
  const user = (content: string) => message('user', content, { metadata: { is_user_input: true } })
  const reply = (content: string, extra: Record<string, unknown> = {}) =>
    message('assistant', content, {
      metadata: { metrics: { input_tokens: 10, output_tokens: 2 } },
      ...extra
    })
  for (const [id, parent, body, metadata] of [
    [1, null, message('system', 'You are Devin'), null],
    [2, 1, user('Say hello'), null],
    [3, 2, reply('Hello.'), null],
    [4, 2, reply('Hello.'), null],
    [5, 4, user('Say goodbye'), null],
    [6, 5, reply('Goodbye.'), null],
    [7, null, message('system', 'You are a Summarizer'), null],
    [8, 7, message('user', 'Conversation to summarize: ...'), null],
    [9, 1, message('system', 'You are continuing work'), JSON.stringify({ summarized_from: 6 })],
    [10, 9, user('And again?'), null],
    [
      11,
      10,
      reply('Again.', {
        tool_calls: [{ id: 'toolu_1', name: 'read', arguments: { file_path: '/work/a.ts' } }]
      }),
      null
    ]
  ] as const) {
    node.run('acp-chat', id, parent, body, 1_777_000_000 + id, metadata)
  }
  node.run('tui-chat', 1, null, user('exported'), 1_777_000_000, null)
  db.prepare('UPDATE sessions SET main_chain_id = 11 WHERE id = ?').run('acp-chat')
  db.close()
  await writeFile(join(cliDir, 'transcripts', 'tui-chat.json'), '{}')
})

afterEach(async () => {
  await rm(join(cliDir, '..', '..'), { recursive: true, force: true })
})

describe('Devin sessions only in sessions.db', () => {
  it('lists visible sessions that have no ATIF export', async () => {
    const discovery = await discoverDevinDbSessions({
      transcriptRoots: [join(cliDir, 'transcripts'), join(cliDir, 'agent_logs')],
      limit: 10,
      issues: []
    })
    expect(
      discovery.files.map((file) => splitDevinDbSessionCandidate(file.path)?.sessionId)
    ).toEqual(['acp-chat'])
    expect(discovery.files[0]?.mtimeMs).toBe(1_777_000_300_000)
  })

  it('reads the conversation across a compaction, without its summarizer or duplicate replies', async () => {
    const discovery = await discoverDevinDbSessions({
      transcriptRoots: [join(cliDir, 'transcripts')],
      limit: 10,
      issues: []
    })
    const file = discovery.files[0]!
    const texts: string[] = []
    const session = parseDevinDbSession(splitDevinDbSessionCandidate(file.path)!, file, 'linux', {
      active: true,
      push: (message) => {
        texts.push(`${message.role}: ${message.text}`)
      }
    })
    expect(session).toMatchObject({
      agent: 'devin',
      sessionId: 'acp-chat',
      title: 'Say hello',
      cwd: '/work',
      model: 'swe-2',
      messageCount: 6,
      totalTokens: 36
    })
    expect(texts).toEqual([
      'user: Say hello',
      'assistant: Hello.',
      'user: Say goodbye',
      'assistant: Goodbye.',
      'user: And again?',
      'assistant: Again.',
      'tool: read: /work/a.ts'
    ])
  })
})
