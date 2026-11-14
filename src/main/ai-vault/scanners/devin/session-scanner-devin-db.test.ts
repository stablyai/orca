import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  devinSessionsIndexForSidecar,
  resetDevinSessionsIndexCacheForTests
} from './session-scanner-devin-db'
import { isolatedScanRoots } from '../../scanner-fixtures/session-scanner-test-fixtures'
import type { SessionSidecarStat } from '../../parse-cache/session-sidecar-stat'

// Mirror the Devin CLI 3000.10.x schema so every probed column exists.
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

const DEVIN_CREATED_S = 1_777_000_000
const DEVIN_ACTIVITY_S = 1_777_003_600

let tempDirs: string[] = []

afterEach(async () => {
  resetDevinSessionsIndexCacheForTests()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type DevinDbRow = {
  id: string
  working_directory?: string | null
  model?: string | null
  title?: string | null
  created_at?: number | null
  last_activity_at?: number | null
  hidden?: number | null
}

function writeDevinSessionsDb(dbPath: string, rows: readonly DevinDbRow[]): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(DEVIN_SESSIONS_SCHEMA)
    db.exec('DELETE FROM sessions')
    const insert = db.prepare(
      `INSERT INTO sessions (id, working_directory, model, title, created_at, last_activity_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(
        row.id,
        row.working_directory ?? null,
        row.model ?? null,
        row.title ?? null,
        row.created_at ?? null,
        row.last_activity_at ?? null,
        row.hidden ?? 0
      )
    }
  } finally {
    db.close()
  }
}

async function sidecarOf(dbPath: string): Promise<SessionSidecarStat> {
  const fileStat = await stat(dbPath)
  return { path: dbPath, mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size }
}

describe('devinSessionsIndexForSidecar', () => {
  it('tolerates an older schema missing optional columns', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    const db = new SyncDatabase(dbPath)
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT)')
      db.prepare('INSERT INTO sessions (id, working_directory) VALUES (?, ?)').run(
        'old-session',
        '/srv/old'
      )
    } finally {
      db.close()
    }
    const { index, unreadable } = devinSessionsIndexForSidecar(await sidecarOf(dbPath))
    expect(unreadable).toBe(false)
    expect(index?.get('old-session')).toEqual({
      workingDirectory: '/srv/old',
      model: null,
      title: null,
      createdAt: null,
      lastActivityAt: null,
      hidden: false
    })
  })
})

describe('devin sessions.db through the scan', () => {
  async function writeDevinVault(
    dir: string,
    directory = 'transcripts'
  ): Promise<{ transcriptsDir: string; dbPath: string }> {
    const cliDir = join(dir, 'devin-cli')
    const transcriptsDir = join(cliDir, directory)
    await mkdir(transcriptsDir, { recursive: true })
    await writeFile(
      join(transcriptsDir, 'devin-shown.json'),
      JSON.stringify({ session_id: 'shown', steps: [] })
    )
    await writeFile(
      join(transcriptsDir, 'hidden.json'),
      JSON.stringify({ session_id: 'hidden', steps: [] })
    )
    const dbPath = join(cliDir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [
      {
        id: 'shown',
        working_directory: '/srv/shown',
        title: 'Shown session',
        model: 'swe-1-6-fast',
        created_at: DEVIN_CREATED_S,
        last_activity_at: DEVIN_ACTIVITY_S
      },
      { id: 'hidden', hidden: 1 }
    ])
    return { transcriptsDir, dbPath }
  }

  it.each(['transcripts', 'agent_logs'])(
    'enriches %s sessions by session_id and excludes hidden ones',
    async (directory) => {
      const root = await tempDir('orca-devin-scan-')
      const { transcriptsDir } = await writeDevinVault(root, directory)
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(root),
        devinTranscriptsDir: transcriptsDir
      })
      const devin = result.sessions.filter((session) => session.agent === 'devin')
      expect(devin.map((session) => session.sessionId)).toEqual(['shown'])
      expect(devin[0]?.cwd).toBe('/srv/shown')
      expect(devin[0]?.title).toBe('Shown session')
      expect(devin[0]?.model).toBe('swe-1-6-fast')
      expect(devin[0]?.createdAt).toBe(new Date(DEVIN_CREATED_S * 1000).toISOString())
    }
  )

  it('picks up db-only changes on a rescan without the transcript moving', async () => {
    const root = await tempDir('orca-devin-scan-')
    const { transcriptsDir, dbPath } = await writeDevinVault(root)
    const options = {
      ...isolatedScanRoots(root),
      devinTranscriptsDir: transcriptsDir
    }
    await scanAiVaultSessions(options)

    // Bump mtime explicitly to detect the update on coarse filesystems.
    writeDevinSessionsDb(dbPath, [
      { id: 'shown', working_directory: '/srv/moved', title: 'Retitled' },
      {
        id: 'hidden',
        hidden: 0,
        working_directory: '/srv/unhidden',
        title: 'Back again'
      }
    ])
    const bumped = Date.now() + 10_000
    await utimes(dbPath, new Date(bumped), new Date(bumped))

    const result = await scanAiVaultSessions(options)
    const devin = result.sessions.filter((session) => session.agent === 'devin')
    const byId = new Map(devin.map((session) => [session.sessionId, session]))
    expect(byId.get('shown')?.cwd).toBe('/srv/moved')
    expect(byId.get('shown')?.title).toBe('Retitled')
    expect(byId.get('hidden')?.cwd).toBe('/srv/unhidden')
    expect(byId.get('hidden')?.title).toBe('Back again')
  })
})
