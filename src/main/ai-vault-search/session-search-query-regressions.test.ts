import { removeTree } from '../../shared/windows-transient-lock-removal'
import { sessionSearchPathKey } from './session-search-path-key'
import { describe, it, expect } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchService } from './session-search-service'
import { openSessionSearchIndexFile } from './session-search-staged-write-test-fixture'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userRecord, parseTranscript } from './session-search-transcript-fixtures'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'

/** The store keeps its connection private, so synthetic rows go in through a second one. */
async function withIndex(
  run: (db: SyncDatabase, store: SessionSearchStore) => void
): Promise<void> {
  const index = await openSessionSearchIndexFile('ss-query-regressions')
  const store = new SessionSearchStore(index.path)
  try {
    run(index.db, store)
  } finally {
    store.close()
    await index.close()
  }
}

function add(
  db: SyncDatabase,
  id: number,
  cwd: string,
  text: string,
  count = 1,
  transcriptPath?: string
) {
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,message_count,resume_command) VALUES (?, 'claude', ?, ?, 'audit fixture', ?, ?, 1, '')`
  ).run(id, String(id), `/synthetic/${id}`, cwd, sessionSearchPathKey(cwd, transcriptPath))
  for (let n = 0; n < count; n++) {
    const row = Number(
      db.prepare("INSERT INTO messages(session_row_id,role) VALUES (?, 'user')").run(id)
        .lastInsertRowid
    )
    db.prepare('INSERT INTO messages_fts(rowid,user_text) VALUES (?,?)').run(row, text)
  }
}

describe('search correctness regressions', () => {
  it('finds a scoped match behind 600 out-of-scope rows', async () => {
    await withIndex((db, store) => {
      add(db, 1, '/unrelated', 'auditneedle', 600)
      add(db, 2, '/target', 'auditneedle padding')
      expect(
        store.search({ query: 'auditneedle', scopePaths: ['/target'] }).hits.map((h) => h.sessionId)
      ).toEqual(['2'])
    })
  })

  it('falls back when the exact hit is out of scope', async () => {
    await withIndex((db, store) => {
      add(db, 1, '/unrelated', 'resolveTerminalPath')
      add(db, 2, '/target', 'resolve terminal path')
      expect(
        store
          .search({ query: 'resolveTerminalPath', scopePaths: ['/target'] })
          .hits.map((h) => h.sessionId)
      ).toEqual(['2'])
    })
  })

  it('phrase route requires adjacent ordered tokens', async () => {
    await withIndex((db, store) => {
      add(db, 1, '/target', 'beta separated alpha')
      expect(store.search({ query: '"alpha beta"' }).route).toBe('and')
    })
  })

  it('unicode term indexed by FTS is searchable', async () => {
    await withIndex((db, store) => {
      add(db, 1, '/target', '안녕하세요')
      expect(
        db
          .prepare('SELECT count(*) as n FROM messages_fts WHERE messages_fts MATCH ?')
          .get('안녕하세요')
      ).toEqual({ n: 1 })
      expect(store.search({ query: '안녕하세요' }).hits).toHaveLength(1)
    })
  })

  it('ordinary list parse respects selected history retention', async () => {
    resetSessionParseCacheForTests()
    const root = await mkdtemp(join(tmpdir(), 'orca-audit-retention-'))
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'p'), { recursive: true })
    const path = join(roots.claudeProjectsDir, 'p', 'history.jsonl')
    await writeFile(path, `${userRecord(0, 'auditretention')}\n`)
    const old = new Date(Date.now() - 120 * 86400000)
    await utimes(path, old, old)
    const s = new SessionSearchService({
      databasePath: join(root, 'index.sqlite'),
      enabled: true,
      historyDays: 30
    })
    try {
      await s.ensureBackfill(roots)
      expect(s.coverage().sessionsIndexed).toBe(0)
      await parseTranscript(path)
      expect(s.coverage().sessionsIndexed).toBe(0)
    } finally {
      await s.close()
      await removeTree(root)
    }
  })
})

describe('path and retrieval contracts', () => {
  it.each([
    ['C:\\Work\\App', 'c:/work/app', true],
    ['C:\\Work\\App\\src', 'c:/work/app', true],
    ['/work/APP/src', '/work/app', false],
    ['/work/caf\u00e9', '/work/cafe\u0301', true],
    ['/work/app-other', '/work/app', false],
    ['/work/a_b/src', '/work/a_b', true],
    ['/work/axb/src', '/work/a_b', false],
    // Roots: both key to a degenerate prefix ('' and 'c:'), which is where a
    // range bound is easiest to get wrong. A Windows key is not under POSIX '/'.
    ['/', '/', true],
    ['/work/app', '/', true],
    ['C:\\Work\\App', '/', false],
    ['C:\\', 'C:\\', true],
    ['C:\\Work\\App', 'C:\\', true]
  ])('scopes %s under %s: %s', async (cwd, scope, expected) => {
    await withIndex((db, store) => {
      add(db, 1, cwd as string, 'needle')
      expect(store.search({ query: 'needle', scopePaths: [scope as string] }).hits.length > 0).toBe(
        expected
      )
      expect(store.search({ query: `needle path:"${scope}"` }).hits.length > 0).toBe(expected)
    })
  })

  it('keeps WSL distro identity and Linux path case', () => {
    expect(
      sessionSearchPathKey('/home/Ada/app', '\\\\wsl.localhost\\Ubuntu\\home\\Ada\\session.jsonl')
    ).toBe(sessionSearchPathKey('\\\\wsl$\\ubuntu\\home\\Ada\\app'))
    expect(sessionSearchPathKey('\\\\wsl$\\Debian\\home\\Ada\\app')).not.toBe(
      sessionSearchPathKey('\\\\wsl$\\Ubuntu\\home\\Ada\\app')
    )
  })

  // Both sorts collapse to one row per session before the candidate limit, so
  // the 650-row session cannot crowd the one-row session off the page.
  it.each(['relevance', 'newest'] as const)(
    '%s returns distinct sessions even when one has over 600 matching rows',
    async (sort) => {
      await withIndex((db, store) => {
        add(db, 1, '/app', 'needle', 650)
        add(db, 2, '/app', 'needle padding')
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-09-06', 1)
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-09-05', 2)
        expect(store.search({ query: 'needle', sort }).hits.map((hit) => hit.sessionId)).toEqual([
          '1',
          '2'
        ])
      })
    }
  )

  // One conversation forked four ways is one answer, whichever page builds it:
  // an operator-only query and a text query see the same sessions.
  it('collapses forks for an operator-only page exactly as for a text page', async () => {
    await withIndex((db, store) => {
      for (const id of [1, 2, 3, 4]) {
        add(db, id, '/repo/app', 'needle')
        db.prepare(
          'UPDATE sessions SET content_hash = ?, content_hash_count = 8, updated_at = ? WHERE id = ?'
        ).run('shared-fork-prefix', `2026-09-0${id}`, id)
      }
      const operatorOnly = store.search({ query: 'repo:app' })
      const withText = store.search({ query: 'needle repo:app' })
      expect(operatorOnly.hits.map((hit) => hit.sessionId)).toEqual(['4'])
      expect(operatorOnly.hits[0]?.duplicateCount).toBe(4)
      expect(withText.hits.map((hit) => hit.sessionId)).toEqual(
        operatorOnly.hits.map((hit) => hit.sessionId)
      )
      expect(withText.hits[0]?.duplicateCount).toBe(4)
    })
  })

  // The index writer can prove a WSL session's distro from its transcript path;
  // a query-time term never can. Orca stores a WSL workspace as the UNC path,
  // which is the spelling that keys the same way the writer did.
  it('scopes a WSL session by its UNC workspace path, not by the Linux spelling', async () => {
    await withIndex((db, store) => {
      add(
        db,
        1,
        '/home/ada/app',
        'needle',
        1,
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\session.jsonl'
      )
      const hits = (scope: string): number =>
        store.search({ query: 'needle', scopePaths: [scope] }).hits.length
      expect(hits('\\\\wsl$\\Ubuntu\\home\\ada\\app')).toBe(1)
      expect(hits('\\\\wsl.localhost\\Ubuntu\\home\\ada')).toBe(1)
      expect(hits('/home/ada/app')).toBe(0)
      expect(hits('\\\\wsl$\\Debian\\home\\ada\\app')).toBe(0)
    })
  })

  it.each(['caf\u00e9', 'C', 'R', 'x', '\u4fee\u590d'])(
    'searches unicode61 token %s',
    async (text) => {
      await withIndex((db, store) => {
        add(db, 1, '/app', text)
        expect(store.search({ query: text }).hits).toHaveLength(1)
      })
    }
  )
})
