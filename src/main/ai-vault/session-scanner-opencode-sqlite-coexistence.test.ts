import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import Database from '../sqlite/sync-database'

let tempRoots: string[] = []
let tempDbDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  for (const dir of tempDbDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempRoots = []
  tempDbDirs = []
})

function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions')
  }
}

function createTempOpenCodeDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ai-vault-sqlite-'))
  tempDbDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

function applyOpenCodeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      model TEXT,
      agent TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

describe('scanAiVaultSessions — OpenCode SQLite + legacy file coexistence', () => {
  it('discovers SQLite sessions next to a custom OpenCode storage directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-custom-opencode-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const opencodeDataDir = join(root, 'custom-opencode')
    const opencodeStorageDir = join(opencodeDataDir, 'storage')
    await mkdir(opencodeStorageDir, { recursive: true })

    const dbPath = join(opencodeDataDir, 'opencode.db')
    const db = new Database(dbPath)
    applyOpenCodeSchema(db)
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('custom-db-session', 'proj-1', 'slug', '/tmp/custom-opencode',
         'Custom SQLite session', '1.0.0',
         1777634010000, 1777634011000, NULL, 'build', 0,
         8, 13, 21, 34, 0)`
    ).run()
    db.close()

    const result = await scanAiVaultSessions({
      ...roots,
      opencodeStorageDir,
      opencodeDbPaths: undefined,
      platform: 'darwin',
      limit: 50
    })

    const session = result.sessions.find((s) => s.sessionId === 'custom-db-session')
    expect(session).toBeDefined()
    expect(session!.agent).toBe('opencode')
    expect(session!.title).toBe('Custom SQLite session')
    expect(session!.filePath).toBe(dbPath)
    expect(session!.totalTokens).toBe(42)
  })

  it('surfaces SQLite sessions alongside legacy file sessions and dedups by sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-mixed-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    // Legacy file session under storage/session/<projectId>/<sessionId>.json
    await mkdir(join(roots.opencodeStorageDir, 'session', 'project'), { recursive: true })
    await mkdir(join(roots.opencodeStorageDir, 'message', 'legacy-session'), { recursive: true })
    await writeFile(
      join(roots.opencodeStorageDir, 'session', 'project', 'legacy-session.json'),
      JSON.stringify({
        id: 'legacy-session',
        directory: '/tmp/legacy',
        title: 'Legacy file session',
        time: { created: 1_777_634_000_000, updated: 1_777_634_001_000 }
      })
    )
    await writeFile(
      join(roots.opencodeStorageDir, 'message', 'legacy-session', 'msg_1.json'),
      JSON.stringify({
        role: 'user',
        summary: { title: 'Legacy file session' },
        time: { created: 1_777_634_000_000 },
        tokens: { input: 5, output: 2 }
      })
    )

    // SQLite session — same sessionId as the legacy file (dedup should keep SQLite)
    const { db, path: dbPath } = createTempOpenCodeDb()
    applyOpenCodeSchema(db)
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('legacy-session', 'proj-1', 'slug', '/tmp/sqlite', 'SQLite session', '1.0.0',
         1777634002000, 1777634003000, ?, 'build', 0,
         100, 40, 10, 5, 0)`
    ).run(JSON.stringify({ id: 'glm-5.2', providerID: 'zai-coding-plan' }))
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES ('msg_sql_1', 'legacy-session', 1777634002500, 1777634002500, ?)`
    ).run(JSON.stringify({ role: 'user', time: { created: 1_777_634_002_500 } }))
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES ('prt_sql_1', 'msg_sql_1', 'legacy-session', 1777634002500, 1777634002500, ?)`
    ).run(JSON.stringify({ type: 'text', text: 'sqlite hello' }))
    db.close()

    // A second SQLite-only session
    const { db: db2, path: dbPath2 } = createTempOpenCodeDb()
    applyOpenCodeSchema(db2)
    db2
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('sqlite-only', 'proj-1', 'slug2', '/tmp/sqlite-only', 'SQLite only', '1.0.0',
         1777634004000, 1777634005000, NULL, 'build', 0,
         50, 20, 0, 0, 0)`
      )
      .run()
    db2.close()

    const result = await scanAiVaultSessions({
      ...roots,
      opencodeDbPaths: [dbPath, dbPath2],
      platform: 'darwin',
      limit: 50
    })

    const opencodeSessions = result.sessions.filter((s) => s.agent === 'opencode')
    const sessionIds = opencodeSessions.map((s) => s.sessionId).sort()
    expect(sessionIds).toEqual(['legacy-session', 'sqlite-only'])

    // Why: dedup keeps the SQLite entry (newer time_updated, source of truth)
    const legacyEntry = opencodeSessions.find((s) => s.sessionId === 'legacy-session')
    expect(legacyEntry).toBeDefined()
    expect(legacyEntry!.title).toBe('SQLite session')
    expect(legacyEntry!.cwd).toBe('/tmp/sqlite')
    expect(legacyEntry!.filePath).toBe(dbPath)
    expect(legacyEntry!.totalTokens).toBe(150)
    expect(legacyEntry!.resumeCommand).toBe(
      "cd '/tmp/sqlite' && opencode --session 'legacy-session'"
    )
  })
})
