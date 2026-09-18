import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { resetDevinSessionsIndexCacheForTests } from '../ai-vault/session-scanner-devin-db'
import { scanDevinUsageFiles } from './scanner'

let tempDirs: string[] = []
const originalDevinHome = process.env.DEVIN_HOME

afterEach(async () => {
  if (originalDevinHome === undefined) {
    delete process.env.DEVIN_HOME
  } else {
    process.env.DEVIN_HOME = originalDevinHome
  }
  resetDevinSessionsIndexCacheForTests()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function makeTranscriptsDir(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-devin-usage-'))
  tempDirs.push(home)
  process.env.DEVIN_HOME = home
  const dir = join(home, 'cli', 'transcripts')
  await mkdir(dir, { recursive: true })
  return dir
}

function transcript(overrides: object = {}): string {
  return JSON.stringify({
    session_id: 's1',
    working_directory: '/repo/main',
    agent: { model_name: 'swe-2' },
    steps: [
      {
        timestamp: '2026-09-01T10:00:00Z',
        metrics: { prompt_tokens: 100, cached_tokens: 25, completion_tokens: 40 }
      },
      {
        timestamp: '2026-09-01T10:05:00Z',
        metrics: { prompt_tokens: 50, completion_tokens: 10 }
      }
    ],
    ...overrides
  })
}

const WORKTREES = [{ repoId: 'r1', worktreeId: 'w1', path: '/repo/main', displayName: 'main' }]

// The Devin CLI sessions.db schema, written out in full because the reader
// probes every column it names.
const DEVIN_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT,
    backend_type TEXT,
    model TEXT,
    agent_mode TEXT,
    created_at INTEGER,
    last_activity_at INTEGER,
    title TEXT,
    main_chain_id TEXT,
    shell_last_seen_index INTEGER,
    cogs_json TEXT,
    workspace_dirs TEXT,
    hidden INTEGER,
    metadata TEXT
  );
`

function writeDevinSessionsDb(
  dbPath: string,
  rows: readonly { id: string; working_directory?: string | null; hidden?: number | null }[]
): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(DEVIN_SESSIONS_SCHEMA)
    db.exec('DELETE FROM sessions')
    const insert = db.prepare(
      'INSERT INTO sessions (id, working_directory, hidden) VALUES (?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(row.id, row.working_directory ?? null, row.hidden ?? 0)
    }
  } finally {
    db.close()
  }
}

describe('scanDevinUsageFiles', () => {
  it('aggregates events into sessions and daily aggregates with worktree attribution', async () => {
    const dir = await makeTranscriptsDir()
    await writeFile(join(dir, 's1.json'), transcript())

    const result = await scanDevinUsageFiles(WORKTREES)

    expect(result.processedFiles).toHaveLength(1)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: 's1',
      primaryWorktreeId: 'w1',
      primaryModel: 'swe-2',
      eventCount: 2,
      totalInputTokens: 150,
      totalCachedInputTokens: 25,
      totalOutputTokens: 50,
      totalTokens: 200
    })
    expect(result.dailyAggregates).toHaveLength(1)
    expect(result.dailyAggregates[0]).toMatchObject({
      day: '2026-09-01',
      worktreeId: 'w1',
      eventCount: 2,
      totalTokens: 200
    })
  })

  it('reuses unchanged files on a rescan and dedupes copied transcripts', async () => {
    const dir = await makeTranscriptsDir()
    const file = join(dir, 's1.json')
    await writeFile(file, transcript())

    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.sessions).toHaveLength(1)

    // A duplicate transcript carrying the same session_id must not double-count.
    await writeFile(join(dir, 's1-copy.json'), transcript())
    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)

    expect(second.sessions).toHaveLength(1)
    expect(second.sessions[0].totalTokens).toBe(200)
    const owners = second.processedFiles.flatMap((f) => f.ownedSessionIds)
    expect(owners).toEqual(['s1'])
    expect(second.processedFiles.some((f) => f.hasDeferredClaims)).toBe(true)
  })

  it('lets the canonical <session>.json claim ahead of a lexicographically earlier copy', async () => {
    const dir = await makeTranscriptsDir()
    // 's1-copy.json' sorts before 's1.json' ('-' < '.'), so a naive
    // sorted-order claim would hand the session to the stale copy forever.
    await writeFile(join(dir, 's1-copy.json'), transcript())
    await writeFile(join(dir, 's1.json'), transcript())

    const result = await scanDevinUsageFiles(WORKTREES)

    expect(result.sessions).toHaveLength(1)
    const owner = result.processedFiles.find((file) => file.ownedSessionIds.includes('s1'))
    expect(owner?.path).toBe(join(dir, 's1.json'))
    const copy = result.processedFiles.find((file) => file.path.endsWith('s1-copy.json'))
    expect(copy?.hasDeferredClaims).toBe(true)
  })

  it('hands the claim back to the canonical file after a copy owned it', async () => {
    const dir = await makeTranscriptsDir()
    const copy = join(dir, 's1-copy.json')
    await writeFile(copy, transcript())

    // Only the copy exists: it owns the session.
    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.processedFiles[0]?.ownedSessionIds).toEqual(['s1'])

    // The canonical transcript appears; the copy must not freeze the session.
    await writeFile(join(dir, 's1.json'), transcript())
    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)

    const secondOwner = second.processedFiles.find((file) => file.ownedSessionIds.includes('s1'))
    expect(secondOwner?.path).toBe(join(dir, 's1.json'))
    expect(second.sessions).toHaveLength(1)
  })

  it('lets a deferred copy reclaim its session once the owner disappears', async () => {
    const dir = await makeTranscriptsDir()
    const canonical = join(dir, 's1.json')
    await writeFile(canonical, transcript())
    await writeFile(join(dir, 's1-copy.json'), transcript())

    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.processedFiles.find((f) => f.path.endsWith('s1.json'))?.ownedSessionIds).toEqual([
      's1'
    ])

    await rm(canonical)
    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)

    expect(second.sessions).toHaveLength(1)
    const copy = second.processedFiles.find((file) => file.path.endsWith('s1-copy.json'))
    expect(copy?.ownedSessionIds).toEqual(['s1'])
  })

  it('lets a deferred copy reclaim its session when the owner stops parsing', async () => {
    const dir = await makeTranscriptsDir()
    const canonical = join(dir, 's1.json')
    await writeFile(canonical, transcript())
    await writeFile(join(dir, 's1-copy.json'), transcript())

    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.processedFiles.find((f) => f.path.endsWith('s1.json'))?.ownedSessionIds).toEqual([
      's1'
    ])

    // The owner stays listed but turns unreadable — without a reclaim pass
    // the copy would sit deferred with the session lost forever.
    await writeFile(canonical, '{ torn write')
    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)

    expect(second.sessions).toHaveLength(1)
    const copy = second.processedFiles.find((file) => file.path.endsWith('s1-copy.json'))
    expect(copy?.ownedSessionIds).toEqual(['s1'])
  })

  it('skips a corrupt transcript without sinking the rest of the scan', async () => {
    const dir = await makeTranscriptsDir()
    await writeFile(join(dir, 'broken.json'), '{ not json')
    await writeFile(join(dir, 's1.json'), transcript())

    const result = await scanDevinUsageFiles(WORKTREES)

    expect(result.processedFiles).toHaveLength(1)
    expect(result.sessions[0]?.sessionId).toBe('s1')
  })

  it('returns an empty projection when no transcripts exist', async () => {
    await makeTranscriptsDir()
    const result = await scanDevinUsageFiles(WORKTREES)
    expect(result.processedFiles).toEqual([])
    expect(result.sessions).toEqual([])
    expect(result.dailyAggregates).toEqual([])
  })

  it('re-attributes an unchanged transcript when only sessions.db moves', async () => {
    const dir = await makeTranscriptsDir()
    // No working_directory in the transcript (the Windows ATIF shape) — the db
    // row is the only attribution source.
    await writeFile(join(dir, 's1.json'), transcript({ working_directory: null }))
    const dbPath = join(dir, '..', 'sessions.db')
    writeDevinSessionsDb(dbPath, [{ id: 's1', working_directory: '/repo/main' }])

    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.sessions[0]?.primaryWorktreeId).toBe('w1')

    writeDevinSessionsDb(dbPath, [{ id: 's1', working_directory: '/repo/other' }])
    // Why: pin the mtime so the sidecar change is visible regardless of fs
    // timestamp granularity — size alone stays identical across rewrites.
    const later = new Date('2026-09-02T00:00:00Z')
    await utimes(dbPath, later, later)

    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)
    expect(second.sessions[0]?.primaryWorktreeId).toBeNull()
    expect(second.sessions[0]?.primaryProjectLabel).toBe('repo/other')
  })

  it('drops a session from the projection once sessions.db marks it hidden', async () => {
    const dir = await makeTranscriptsDir()
    await writeFile(join(dir, 's1.json'), transcript({ working_directory: null }))
    const dbPath = join(dir, '..', 'sessions.db')
    writeDevinSessionsDb(dbPath, [{ id: 's1', working_directory: '/repo/main', hidden: 0 }])

    const first = await scanDevinUsageFiles(WORKTREES)
    expect(first.sessions).toHaveLength(1)

    writeDevinSessionsDb(dbPath, [{ id: 's1', working_directory: '/repo/main', hidden: 1 }])
    const later = new Date('2026-09-02T00:00:00Z')
    await utimes(dbPath, later, later)

    const second = await scanDevinUsageFiles(WORKTREES, first.processedFiles)
    expect(second.sessions).toEqual([])
    expect(second.dailyAggregates).toEqual([])
  })

  it('observes sessions.db-wal while the db runs in WAL mode', async () => {
    const dir = await makeTranscriptsDir()
    await writeFile(join(dir, 's1.json'), transcript({ working_directory: null }))
    const dbPath = join(dir, '..', 'sessions.db')
    const db = new SyncDatabase(dbPath)
    try {
      db.exec(DEVIN_SESSIONS_SCHEMA)
      db.pragma('journal_mode = WAL')
      db.prepare('INSERT INTO sessions (id, working_directory) VALUES (?, ?)').run(
        's1',
        '/repo/main'
      )

      // The open connection keeps sessions.db-wal on disk; the observation
      // must ride the wal stat, not the untouched db file.
      const result = await scanDevinUsageFiles(WORKTREES)
      expect(result.sessions[0]?.primaryWorktreeId).toBe('w1')
      expect(result.processedFiles[0]?.sessionsDb).toMatchObject({
        path: `${dbPath}-wal`
      })
    } finally {
      db.close()
    }
  })
})
