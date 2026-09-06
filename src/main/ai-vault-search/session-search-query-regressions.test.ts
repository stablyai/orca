import { sessionSearchPathKey } from './session-search-path-key'
import { describe, it, expect } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchService } from './session-search-service'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userRecord, parseTranscript } from './session-search-transcript-fixtures'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
function add(store: SessionSearchStore, id: number, cwd: string, text: string, count = 1) {
  store.db
    .prepare(
      `INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,message_count,resume_command) VALUES (?, 'claude', ?, ?, 'audit fixture', ?, ?, 1, '')`
    )
    .run(id, String(id), `/synthetic/${id}`, cwd, sessionSearchPathKey(cwd))
  for (let n = 0; n < count; n++) {
    const row = Number(
      store.db.prepare("INSERT INTO messages(session_row_id,role) VALUES (?, 'user')").run(id)
        .lastInsertRowid
    )
    store.db.prepare('INSERT INTO messages_fts(rowid,user_text) VALUES (?,?)').run(row, text)
  }
}
describe('search correctness regressions', () => {
  it('finds a scoped match behind 600 out-of-scope rows', () => {
    const s = new SessionSearchStore(':memory:')
    try {
      add(s, 1, '/unrelated', 'auditneedle', 600)
      add(s, 2, '/target', 'auditneedle padding')
      expect(
        s.search({ query: 'auditneedle', scopePaths: ['/target'] }).hits.map((h) => h.sessionId)
      ).toEqual(['2'])
    } finally {
      s.close()
    }
  })
  it('falls back when the exact hit is out of scope', () => {
    const s = new SessionSearchStore(':memory:')
    try {
      add(s, 1, '/unrelated', 'resolveTerminalPath')
      add(s, 2, '/target', 'resolve terminal path')
      expect(
        s
          .search({ query: 'resolveTerminalPath', scopePaths: ['/target'] })
          .hits.map((h) => h.sessionId)
      ).toEqual(['2'])
    } finally {
      s.close()
    }
  })
  it('phrase route requires adjacent ordered tokens', () => {
    const s = new SessionSearchStore(':memory:')
    try {
      add(s, 1, '/target', 'beta separated alpha')
      expect(s.search({ query: '"alpha beta"' }).route).toBe('and')
    } finally {
      s.close()
    }
  })
  it('unicode term indexed by FTS is searchable', () => {
    const s = new SessionSearchStore(':memory:')
    try {
      add(s, 1, '/target', '안녕하세요')
      expect(
        s.db
          .prepare('SELECT count(*) as n FROM messages_fts WHERE messages_fts MATCH ?')
          .get('안녕하세요')
      ).toEqual({ n: 1 })
      expect(s.search({ query: '안녕하세요' }).hits).toHaveLength(1)
    } finally {
      s.close()
    }
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
      s.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('path and retrieval contracts', () => {
  it.each([
    ['C:\\Work\\App', 'c:/work/app', true],
    ['C:\\Work\\App\\src', 'c:/work/app', true],
    ['/work/APP/src', '/work/app', false],
    ['/work/café', '/work/cafe\u0301', true],
    ['/work/app-other', '/work/app', false],
    ['/work/a_b/src', '/work/a_b', true],
    ['/work/axb/src', '/work/a_b', false]
  ])('scopes %s under %s: %s', (cwd, scope, expected) => {
    const store = new SessionSearchStore(':memory:')
    try {
      add(store, 1, cwd, 'needle')
      expect(store.search({ query: 'needle', scopePaths: [scope] }).hits.length > 0).toBe(expected)
      expect(store.search({ query: `needle path:"${scope}"` }).hits.length > 0).toBe(expected)
    } finally {
      store.close()
    }
  })

  it('keeps WSL distro identity and Linux path case', () => {
    expect(
      sessionSearchPathKey('/home/Ada/app', '\\\\wsl.localhost\\Ubuntu\\home\\Ada\\session.jsonl')
    ).toBe(sessionSearchPathKey('\\\\wsl$\\ubuntu\\home\\Ada\\app'))
    expect(sessionSearchPathKey('\\\\wsl$\\Debian\\home\\Ada\\app')).not.toBe(
      sessionSearchPathKey('\\\\wsl$\\Ubuntu\\home\\Ada\\app')
    )
  })

  it('newest returns distinct sessions even when one has over 600 matching rows', () => {
    const store = new SessionSearchStore(':memory:')
    try {
      add(store, 1, '/app', 'needle', 650)
      add(store, 2, '/app', 'needle padding')
      store.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-09-06', 1)
      store.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-09-05', 2)
      expect(
        store.search({ query: 'needle', sort: 'newest' }).hits.map((hit) => hit.sessionId)
      ).toEqual(['1', '2'])
    } finally {
      store.close()
    }
  })

  it.each(['café', 'C', 'R', 'x', '修复'])('searches unicode61 token %s', (text) => {
    const store = new SessionSearchStore(':memory:')
    try {
      add(store, 1, '/app', text)
      expect(store.search({ query: text }).hits).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
