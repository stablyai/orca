import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { readOpenCodeTranscriptPage } from '../native-chat/transcript-opencode-sqlite-query'
import {
  openCodeStoredUserMessagesReader,
  type OpenCodeTranscriptPageReader
} from './opencode-acp-stored-messages'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** An `opencode.db` under a fresh XDG data home, built by `schema`; returns that data home. */
function dataHomeWith(schema: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-opencode-stored-'))
  roots.push(root)
  mkdirSync(join(root, 'opencode'))
  const db = new Database(join(root, 'opencode', 'opencode.db'))
  db.exec(schema)
  db.close()
  return root
}

/** The bounded reader in-process, standing in for its worker. */
const readInProcess: OpenCodeTranscriptPageReader = async (args) => readOpenCodeTranscriptPage(args)

function readFrom(dataHome: string) {
  return openCodeStoredUserMessagesReader(readInProcess)({
    env: { HOME: dataHome, USERPROFILE: dataHome, XDG_DATA_HOME: dataHome },
    providerSessionId: 'ses_1',
    signal: new AbortController().signal
  })
}

const OPENCODE_2_TABLES = `CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    data TEXT, time_created INTEGER, time_updated INTEGER);`

describe('OpenCode stored user messages', () => {
  it("reads the database under the chat's own home, and only its user messages", async () => {
    const readPage = vi.fn<OpenCodeTranscriptPageReader>(async () => ({
      items: [
        {
          rowid: 1,
          fingerprint: 'a',
          message: { id: 'msg_1', role: 'user', blocks: [], timestamp: 5, source: 'transcript' }
        },
        {
          rowid: 2,
          fingerprint: 'b',
          message: {
            id: 'msg_2',
            role: 'assistant',
            blocks: [],
            timestamp: 6,
            source: 'transcript'
          }
        }
      ],
      hasMore: false,
      beforeMessageRowId: 1
    }))
    const home = join('/', 'child-home')
    const read = openCodeStoredUserMessagesReader(readPage)
    await expect(
      read({
        env: { HOME: home, USERPROFILE: home },
        providerSessionId: 'ses_1',
        signal: new AbortController().signal
      })
    ).resolves.toEqual([{ id: 'msg_1', blocks: [], createdAt: 5 }])
    expect(readPage).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: join(home, '.local', 'share', 'opencode', 'opencode.db'),
        sessionId: 'ses_1'
      }),
      expect.anything()
    )
  })

  it('reads a 2.x session from its live tables, not the frozen 1.x copy an upgrade left', async () => {
    const dataHome = dataHomeWith(`${OPENCODE_2_TABLES}
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER,
        data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('ses_1');
      INSERT INTO message VALUES ('old', 'ses_1', 1, 1, '{"role":"user"}');
      INSERT INTO part VALUES ('p', 'old', 'ses_1', 1, '{"type":"text","text":"frozen"}');
      INSERT INTO session_v2 VALUES ('ses_1');
      INSERT INTO session_message VALUES
        ('u1', 'ses_1', 'user', 1, '{"text":"live prompt"}', 50, 50),
        ('a1', 'ses_1', 'assistant', 2, '{"content":[{"type":"text","text":"reply"}]}', 60, 60);`)
    await expect(readFrom(dataHome)).resolves.toEqual([
      { id: 'opencode:u1', blocks: [{ type: 'text', text: 'live prompt' }], createdAt: 50 }
    ])
  })

  it('finds nothing in a 2.x database whose message table it does not know', async () => {
    const dataHome = dataHomeWith(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      INSERT INTO session_v2 VALUES ('ses_1');`)
    await expect(readFrom(dataHome)).resolves.toBeNull()
  })
})
