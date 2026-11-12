import { openCode2ForkStore } from './transcript-opencode2-fork.test-fixture'
import { handleOpenCodeSqliteRequest } from '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-dispatch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { readOpenCodeTranscriptPage } from './transcript-opencode-sqlite-query'

const fixtures: { db: Database.Database; root: string }[] = []
afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-opencode2-'))
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  fixtures.push({ db, root })
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('session');
    ALTER TABLE session_v2 ADD COLUMN directory TEXT;
    UPDATE session_v2 SET directory = '/folder';`)
  const insertMessage = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
  let sequence = 0
  const insert = (id: string, type: string, data: unknown, time = 1) =>
    insertMessage.run(id, 'session', type, ++sequence, JSON.stringify(data), time, time)
  return { path, insert, db }
}

it.each([true, false])(
  'uses genuine v2 idle evidence for the imported latest root, completed: %s',
  async (completed) => {
    const { path, insert } = fixture()
    insert('u1', 'user', { text: 'First prompt' })
    insert('a1', 'assistant', { content: [{ type: 'text', text: 'First response' }] })
    insert('idle1', 'idle', { outcome: 'succeeded' })
    insert('u2', 'user', { text: 'Latest prompt' })
    insert('a2', 'assistant', { content: [{ type: 'text', text: 'Latest prose' }] })
    if (completed) {
      insert('idle2', 'idle', { outcome: 'succeeded' })
    }
    const imported = await readOpenCodeNativeChatTranscriptFull('session', {
      resolveDbPath: async () => path,
      readPage: async (args) => readOpenCodeTranscriptPage(args)
    })
    expect(imported).toMatchObject({
      forkTipItemIds: completed ? ['opencode:u2', 'opencode:a2', 'opencode:idle2'] : []
    })
  }
)

it('captures the M1 copied roots without events, excludes a racing CLI root, and honors before', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-opencode2-fork-'))
  const path = join(root, 'opencode.db')
  const db = openCode2ForkStore(path)
  fixtures.push({ db, root })
  const request = {
    id: 1,
    kind: 'fork-coverage' as const,
    dbPath: path,
    sessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg',
    sourceSessionId: 'ses_e4d7a0c31ffejclsdjiiDszHMB'
  }
  expect(await handleOpenCodeSqliteRequest(request)).toEqual({
    id: 1,
    ok: true,
    value: ['msg_1b2868ada001HhsJYcY0OtPOjp_4']
  })
  expect(
    await handleOpenCodeSqliteRequest({ ...request, sourceSessionId: 'wrong-source' })
  ).toMatchObject({ ok: false })
  db.exec(`UPDATE session_v2 SET fork_boundary =
    '{"type":"before","messageID":"msg_1b285f9e10016X0Hu1rKOHAACe"}'
    WHERE id = 'ses_e4d797526ffee7BYM6ri3gpmbg';
    DELETE FROM session_message WHERE session_id = 'ses_e4d797526ffee7BYM6ri3gpmbg' AND seq < 90;`)
  expect(await handleOpenCodeSqliteRequest(request)).toEqual({ id: 1, ok: true, value: [] })
})

it.each([100, 1000])(
  'decodes each of %i v2 messages once for content and fork evidence',
  (count) => {
    const { path, insert } = fixture()
    const data = { content: [{ type: 'text', text: 'response' }], outcome: 'succeeded' }
    const raw = JSON.stringify(data)
    for (let index = 1; index <= count; index++) {
      insert(`msg-${index}`, index === count ? 'idle' : 'assistant', data)
    }
    const parse = vi.spyOn(JSON, 'parse')
    let page
    let decodes
    try {
      page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: count })
      decodes = parse.mock.calls.filter(([input]) => input === raw).length
    } finally {
      parse.mockRestore()
    }
    expect(decodes).toBe(count)
    expect(page?.items).toHaveLength(count)
    expect(page?.items[0].message).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'response' }]
    })
    expect(page?.forkTip).toHaveLength(count)
    expect(page?.forkTip?.at(-1)).toEqual({
      id: `opencode:msg-${count}`,
      role: 'terminal',
      terminal: true
    })
    expect(page?.hasMore).toBe(false)
  }
)
