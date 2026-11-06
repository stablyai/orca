import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { readHermesTranscriptPage, readHermesTranscriptSignal } from './transcript-hermes-sqlite'
import { OPENCODE_TRANSCRIPT_MAX_ROW_BYTES } from './transcript-opencode-part-blocks'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../shared/agent-session/view/agent-session-host-status-rows'
import { handleOpenCodeSqliteRequest } from '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-dispatch'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-transcript-'))
  directories.push(dir)
  const path = join(dir, 'state.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO sessions VALUES ('session-a'), ('session-b');
    INSERT INTO messages VALUES
      (1, 'session-a', 'user', 'Hello', NULL, NULL, 1700000000, 1, 0),
      (2, 'session-b', 'user', 'Other session', NULL, NULL, 1700000001, 1, 0),
      (3, 'session-a', 'assistant', 'Hi', NULL, NULL, 1700000002, 1, 0),
      (4, 'session-a', 'user', 'Rewound', NULL, NULL, 1700000003, 0, 0),
      (5, 'session-a', 'assistant', '', '[{"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]', NULL, 1700000004, 1, 0),
      (6, 'session-a', 'tool', 'contents', NULL, 'call-1', 1700000005, 1, 0);
  `)
  db.close()
  return path
}

describe('Hermes transcript database', () => {
  it('reads only the selected session, pages in insertion order, and decodes tool records', () => {
    const dbPath = fixture()
    const originalBytes = readFileSync(dbPath)
    const latest = readHermesTranscriptPage({ dbPath, sessionId: 'session-a', limit: 2 })
    expect(latest?.hasMore).toBe(true)
    expect(latest?.items.map((item) => item.message.transcriptOffset)).toEqual([5, 6])
    expect(latest?.items.map((item) => item.message.blocks)).toEqual([
      [{ type: 'tool-call', name: 'read_file', input: { path: 'a.txt' }, callId: 'call-1' }],
      [{ type: 'tool-result', output: 'contents', callId: 'call-1' }]
    ])
    const earlier = readHermesTranscriptPage({
      dbPath,
      sessionId: 'session-a',
      limit: 2,
      beforeMessageRowId: latest?.beforeMessageRowId ?? 0
    })
    expect(earlier?.items.map((item) => item.message.blocks)).toEqual([
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: 'Hi' }]
    ])
    expect(earlier?.hasMore).toBe(false)
    expect(readHermesTranscriptPage({ dbPath, sessionId: 'missing', limit: 10 })).toBeNull()
    expect(readHermesTranscriptSignal(dbPath, 'session-a')).toMatchObject({
      messageCount: 4,
      maxMessageRowId: 6
    })
    expect(readFileSync(dbPath)).toEqual(originalBytes)
  })

  it('serves worker reads and detects messages appended by the running agent', async () => {
    const dbPath = fixture()
    const before = readHermesTranscriptSignal(dbPath, 'session-a')
    const writer = new Database(dbPath)
    writer
      .prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run('session-a', 'assistant', 'A new reply', 1700000006)
    writer.close()
    const after = readHermesTranscriptSignal(dbPath, 'session-a')
    expect(after?.messageCount).toBe((before?.messageCount ?? 0) + 1)
    expect(after?.maxMessageRowId).toBeGreaterThan(before?.maxMessageRowId ?? 0)
    const response = await handleOpenCodeSqliteRequest({
      id: 1,
      kind: 'native-page',
      agent: 'hermes',
      dbPath,
      sessionId: 'session-a',
      limit: 1
    })
    expect(response).toMatchObject({
      ok: true,
      value: {
        items: [{ message: { role: 'assistant', blocks: [{ type: 'text', text: 'A new reply' }] } }]
      }
    })
  })

  it('decodes Hermes sentinel-encoded structured message content', () => {
    const dbPath = fixture()
    const writer = new Database(dbPath)
    writer
      .prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(
        'session-a',
        'user',
        `\0json:${JSON.stringify([{ type: 'text', text: 'Structured prompt' }])}`,
        1700000006
      )
    writer.close()
    const page = readHermesTranscriptPage({ dbPath, sessionId: 'session-a', limit: 1 })
    expect(page?.items[0]?.message.blocks).toEqual([{ type: 'text', text: 'Structured prompt' }])
  })

  it('streams an appended message without switching or writing the session', async () => {
    const dbPath = fixture()
    const onInitialSnapshot = vi.fn()
    const onAppend = vi.fn()
    const onReplace = vi.fn()
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'hermes',
        sessionId: 'session-a',
        onInitialSnapshot,
        onAppend,
        onReplace,
        resolvePollIntervalMs: 20
      },
      undefined,
      {
        resolveDbPath: async () => dbPath,
        readSignal: async (path, sessionId) => readHermesTranscriptSignal(path, sessionId),
        readPage: async (args) => readHermesTranscriptPage(args)
      }
    )
    try {
      await vi.waitFor(() => expect(onInitialSnapshot).toHaveBeenCalled())
      const writer = new Database(dbPath)
      writer
        .prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('session-a', 'assistant', 'Live reply', 1700000007)
      writer.close()
      await vi.waitFor(() =>
        expect(onAppend).toHaveBeenCalledWith([
          expect.objectContaining({
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Live reply' }]
          })
        ])
      )
      const editor = new Database(dbPath)
      editor
        .prepare('UPDATE messages SET content = ? WHERE session_id = ? AND id = ?')
        .run('Edited reply', 'session-a', 7)
      editor.close()
      await vi.waitFor(() =>
        expect(onReplace).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ blocks: [{ type: 'text', text: 'Edited reply' }] })
          ]),
          expect.any(Boolean),
          expect.any(Number)
        )
      )
    } finally {
      subscription.unsubscribe()
    }
  })

  it('replaces an oversized field and still returns the rest of the page', () => {
    const dbPath = fixture()
    const db = new Database(dbPath)
    const huge = 'x'.repeat(OPENCODE_TRANSCRIPT_MAX_ROW_BYTES + 1)
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(7, 'session-a', 'tool', huge, null, 'call-1', 1700000006, 1, 0)
    insert.run(8, 'session-a', 'assistant', 'kept', huge, null, 1700000007, 1, 0)
    insert.run(9, 'session-a', 'tool', null, null, 'call-2', 1700000008, 1, 0)
    db.close()
    const page = readHermesTranscriptPage({ dbPath, sessionId: 'session-a', limit: 5 })
    const byOffset = new Map(
      page?.items.map((item) => [item.message.transcriptOffset, item.message])
    )
    expect(byOffset.get(7)?.blocks).toEqual([
      {
        type: 'tool-result',
        output: AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'],
        callId: 'call-1'
      }
    ])
    expect(byOffset.get(8)?.blocks).toEqual([
      { type: 'text', text: 'kept' },
      {
        type: 'text',
        text: AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'],
        presentation: 'history-item-too-large'
      }
    ])
    expect(byOffset.get(9)?.blocks).toEqual([{ type: 'tool-result', output: '', callId: 'call-2' }])
  })

  it('pages a set of permitted fields before the aggregate budget throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-transcript-'))
    directories.push(dir)
    const dbPath = join(dir, 'state.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions VALUES ('session-a');
    `)
    const field = 'x'.repeat(OPENCODE_TRANSCRIPT_MAX_ROW_BYTES)
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let id = 1; id <= 9; id += 1) {
      insert.run(id, 'session-a', 'user', field, null, null, 1700000000 + id, 1, 0)
    }
    db.close()
    const seen: number[] = []
    let before: number | undefined
    let pages = 0
    while (pages < 4) {
      const page = readHermesTranscriptPage({
        dbPath,
        sessionId: 'session-a',
        limit: 50,
        ...(before === undefined ? {} : { beforeMessageRowId: before })
      })
      expect(page?.items.length).toBeGreaterThan(0)
      seen.push(...(page?.items.map((item) => item.message.transcriptOffset ?? -1) ?? []))
      pages += 1
      if (!page?.hasMore) {
        break
      }
      before = page.beforeMessageRowId ?? undefined
    }
    expect(pages).toBeGreaterThan(1)
    expect(seen.toSorted((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
