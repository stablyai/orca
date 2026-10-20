import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { runCodexAppServerSession } from './codex-app-server-session'
import { applyCodexSharedStoreConfig } from './codex-shared-store-config'
import { migrateCodexHomeToSharedStore } from './codex-shared-store-migration'

const PINNED = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
const REVERTED = '019a1566-3ec8-7bf2-bcb0-71c09cfb4e9d'
const PINNED_THREAD = '019a1566-3ec8-7bf2-bcb0-71c09cfb4e9e'
const REVERT_SEGMENT = '019a1567-0000-7000-8000-000000000001'

let roots: string[] = []
afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots = []
})

function stateDb(home: string, rows: [id: string, file: string, section: string | null][]): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(`CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO thread_sections VALUES ('${PINNED}', 'Pinned');
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, thread_section_id TEXT,
      section_position INTEGER, section_entered_at_ms INTEGER);`)
  for (const [id, file, section] of rows) {
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, 1, ?)').run(
      id,
      file,
      section,
      section ? 5 : null
    )
  }
  db.close()
}

describe('moving an account home onto the shared Codex store', () => {
  it('links the store, keeps the newer branch and the pin, then names the shared database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-shared-store-'))
    roots.push(root)
    const store = join(root, 'dot-codex')
    const account = join(root, 'codex-accounts', 'a', 'home')
    const day = join('2026', '06', '12')
    const original = `rollout-2026-06-12T10-00-00-${REVERTED}.jsonl`
    const reverted = `rollout-2026-06-12T10-05-00-${REVERTED}_${REVERT_SEGMENT}.jsonl`
    const pinned = `rollout-2026-06-12T09-00-00-${PINNED_THREAD}.jsonl`
    for (const [home, files] of [
      [store, [original]],
      [account, [original, reverted, pinned]]
    ] as const) {
      mkdirSync(join(home, 'sessions', day), { recursive: true })
      for (const file of files) {
        writeFileSync(join(home, 'sessions', day, file), `{"type":"session_meta"}\n`)
      }
    }
    // The shared DB still selects the pre-revert file; only the account's own DB moved on.
    stateDb(store, [[REVERTED, join(store, 'sessions', day, original), null]])
    stateDb(account, [
      [REVERTED, join(account, 'sessions', day, reverted), null],
      [PINNED_THREAD, join(account, 'sessions', day, pinned), PINNED]
    ])
    const calls: { home: string; method: string; params: unknown }[] = []
    const run: typeof runCodexAppServerSession = async (invocation, body) =>
      body({
        request: async (method, params) => {
          calls.push({ home: invocation.env?.CODEX_HOME ?? '', method, params })
          if (method === 'thread/fork') {
            return { thread: { id: 'forked-thread' } }
          }
          return method === 'threadSection/list' ? { data: [{ id: PINNED, name: 'Pinned' }] } : {}
        },
        notify: () => {}
      })

    expect(applyCodexSharedStoreConfig('model = "x"\n', account)).toBe('model = "x"\n')
    await expect(migrateCodexHomeToSharedStore(account, store, { run })).resolves.toBe('complete')

    for (const name of ['sessions', 'archived_sessions', 'thread-writer-locks']) {
      expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(true)
    }
    // Nothing is deleted: the old tree stays beside the link, and its files joined the store.
    expect(existsSync(join(account, 'sessions.before-shared-store', day, reverted))).toBe(true)
    expect(existsSync(join(store, 'sessions', day, reverted))).toBe(true)
    expect(calls).toEqual(
      expect.arrayContaining([
        { home: account, method: 'thread/fork', params: { threadId: REVERTED } },
        { home: store, method: 'thread/read', params: { threadId: 'forked-thread' } },
        { home: store, method: 'thread/read', params: { threadId: PINNED_THREAD } },
        {
          home: store,
          method: 'thread/section/move',
          params: { threadId: PINNED_THREAD, sectionId: PINNED }
        }
      ])
    )
    expect(readFileSync(join(account, '.orca-shared-store.json'), 'utf8')).toContain(
      '"completed":true'
    )
    expect(applyCodexSharedStoreConfig('model = "x"\n', account)).toBe(
      `sqlite_home = ${JSON.stringify(realpathSync(store))} # orca: shared conversation store\nmodel = "x"\n`
    )
  })
})
