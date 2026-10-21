import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { scanAiVaultSessions } from './session-scanner'
import {
  devinSessionsDbDependencyPath,
  devinSessionsDbPath,
  devinSessionsIndexForSidecar,
  resetDevinSessionsIndexCacheForTests
} from './session-scanner-devin-db'
import { parseDevinSessionContent } from './session-scanner-devin-parser'
import { enrichSessionFromSidecar } from './session-scanner-sidecar-enrichment'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'
import type { SessionSidecarStat } from './session-sidecar-stat'

// The Devin CLI sessions.db schema (3000.10.x). Written out in full rather
// than trimmed, because the reader probes every column it names.
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

function devinCandidate(filePath: string, sidecar: FileWithMtime['sidecar']): SessionFileCandidate {
  return {
    agent: 'devin',
    file: {
      path: filePath,
      mtimeMs: 1,
      modifiedAt: new Date(1).toISOString(),
      sidecar
    },
    codexHome: null
  }
}

function devinFoldSession(filePath: string, record: Record<string, unknown>) {
  return parseDevinSessionContent(
    { path: filePath, mtimeMs: 1, modifiedAt: new Date(1).toISOString() },
    JSON.stringify(record),
    'linux'
  )
}

describe('devinSessionsDbPath', () => {
  it('names the sessions.db beside the transcripts dir', () => {
    expect(devinSessionsDbPath(join('cli', 'transcripts', 'apricot-houseboat.json'))).toBe(
      join('cli', 'sessions.db')
    )
  })
})

describe('devinSessionsDbDependencyPath', () => {
  it('points at sessions.db until a wal file appears beside it', async () => {
    const dir = await tempDir('orca-devin-db-')
    const cliDir = join(dir, 'cli')
    const transcriptPath = join(cliDir, 'transcripts', 'apricot.json')
    const dbPath = join(cliDir, 'sessions.db')
    expect(await devinSessionsDbDependencyPath(transcriptPath)).toBe(dbPath)
    await mkdir(cliDir, { recursive: true })
    await writeFile(`${dbPath}-wal`, 'wal bytes')
    expect(await devinSessionsDbDependencyPath(transcriptPath)).toBe(`${dbPath}-wal`)
  })
})

describe('devinSessionsIndexForSidecar', () => {
  it('reads rows keyed by session id with unix seconds as ISO strings', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [
      {
        id: 'apricot-houseboat',
        working_directory: 'D:\\work\\orca',
        model: 'swe-1-6-fast',
        title: 'Fix the vault',
        created_at: DEVIN_CREATED_S,
        last_activity_at: DEVIN_ACTIVITY_S,
        hidden: 0
      },
      { id: 'hidden-one', hidden: 1 }
    ])

    const { index, unreadable } = devinSessionsIndexForSidecar(await sidecarOf(dbPath))
    expect(unreadable).toBe(false)
    const row = index?.get('apricot-houseboat')
    expect(row).toEqual({
      workingDirectory: 'D:\\work\\orca',
      model: 'swe-1-6-fast',
      title: 'Fix the vault',
      createdAt: new Date(DEVIN_CREATED_S * 1000).toISOString(),
      lastActivityAt: new Date(DEVIN_ACTIVITY_S * 1000).toISOString(),
      hidden: false
    })
    expect(index?.get('hidden-one')?.hidden).toBe(true)
  })

  it('returns no index when discovery observed no db', () => {
    expect(devinSessionsIndexForSidecar('none').index).toBeNull()
    expect(devinSessionsIndexForSidecar(undefined).index).toBeNull()
  })

  it('marks a stat-refused db unreadable without opening it', () => {
    const { index, unreadable } = devinSessionsIndexForSidecar('unknown')
    expect(index).toBeNull()
    expect(unreadable).toBe(true)
  })

  it('yields an empty index when the sessions table is absent', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    const db = new SyncDatabase(dbPath)
    try {
      db.exec('CREATE TABLE other (id TEXT)')
    } finally {
      db.close()
    }
    const { index, unreadable } = devinSessionsIndexForSidecar(await sidecarOf(dbPath))
    expect(unreadable).toBe(false)
    expect(index?.size).toBe(0)
  })

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

  it('reports a corrupt db as unreadable rather than throwing', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    await writeFile(dbPath, 'this is not sqlite')
    const { index, unreadable } = devinSessionsIndexForSidecar(await sidecarOf(dbPath))
    expect(index).toBeNull()
    expect(unreadable).toBe(true)
  })

  it('invalidates when the observed file changes from db to wal with identical stats', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [{ id: 'apricot', title: 'old' }])
    const observation = await sidecarOf(dbPath)
    expect(devinSessionsIndexForSidecar(observation).index?.get('apricot')?.title).toBe('old')
    writeDevinSessionsDb(dbPath, [{ id: 'apricot', title: 'new' }])
    const updated = devinSessionsIndexForSidecar({ ...observation, path: `${dbPath}-wal` })
    expect(updated.index?.get('apricot')?.title).toBe('new')
  })

  it('opens the db for a wal observation and re-reads when the wal stat moves', async () => {
    const dir = await tempDir('orca-devin-db-')
    const dbPath = join(dir, 'sessions.db')
    const walPath = `${dbPath}-wal`
    writeDevinSessionsDb(dbPath, [{ id: 'apricot', title: 'old' }])
    const dbStatBefore = await stat(dbPath)
    await writeFile(walPath, 'wal-v1')

    const first = devinSessionsIndexForSidecar(await sidecarOf(walPath))
    expect(first.unreadable).toBe(false)
    expect(first.index?.get('apricot')?.title).toBe('old')

    // A wal-mode write can leave the db stat untouched; restore it so only
    // the wal observation differs between reads.
    writeDevinSessionsDb(dbPath, [{ id: 'apricot', title: 'new' }])
    await utimes(dbPath, dbStatBefore.atimeMs / 1000, dbStatBefore.mtimeMs / 1000)
    await writeFile(walPath, 'wal-v2-longer')

    const second = devinSessionsIndexForSidecar(await sidecarOf(walPath))
    expect(second.unreadable).toBe(false)
    expect(second.index?.get('apricot')?.title).toBe('new')
  })
})

describe('enrichSessionFromSidecar for devin', () => {
  it('fills cwd, generated title, model and timestamps from the db row', async () => {
    const dir = await tempDir('orca-devin-db-')
    const cliDir = join(dir, 'cli')
    const transcriptsDir = join(cliDir, 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    const filePath = join(transcriptsDir, 'apricot.json')
    const dbPath = join(cliDir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [
      {
        id: 'apricot',
        working_directory: '/srv/work',
        model: 'swe-1-6-fast',
        title: 'Db title',
        created_at: DEVIN_CREATED_S,
        last_activity_at: DEVIN_ACTIVITY_S
      }
    ])

    const fold = devinFoldSession(filePath, {
      session_id: 'apricot',
      steps: []
    })
    expect(fold?.cwd).toBeNull()
    const { session, refused } = await enrichSessionFromSidecar(
      devinCandidate(filePath, await sidecarOf(dbPath)),
      fold,
      'linux'
    )
    expect(refused).toBe(false)
    expect(session?.cwd).toBe('/srv/work')
    expect(session?.title).toBe('Db title')
    expect(session?.model).toBe('swe-1-6-fast')
    expect(session?.createdAt).toBe(new Date(DEVIN_CREATED_S * 1000).toISOString())
    expect(session?.updatedAt).toBe(new Date(DEVIN_ACTIVITY_S * 1000).toISOString())
    expect(session?.resumeCommand).toContain('/srv/work')
  })

  it('keeps transcript-derived fields over the db row', async () => {
    const dir = await tempDir('orca-devin-db-')
    const cliDir = join(dir, 'cli')
    const transcriptsDir = join(cliDir, 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    const filePath = join(transcriptsDir, 'apricot.json')
    const dbPath = join(cliDir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [
      {
        id: 'apricot',
        working_directory: '/srv/db-cwd',
        model: 'db-model',
        title: 'Db title',
        created_at: DEVIN_CREATED_S
      }
    ])

    const fold = devinFoldSession(filePath, {
      session_id: 'apricot',
      working_directory: '/srv/transcript-cwd',
      agent: { model_name: 'transcript-model' },
      steps: [
        {
          metadata: {
            created_at: '2026-05-01T10:00:00.000Z',
            is_user_input: true
          },
          text: 'Transcript title'
        }
      ]
    })
    const { session } = await enrichSessionFromSidecar(
      devinCandidate(filePath, await sidecarOf(dbPath)),
      fold,
      'linux'
    )
    expect(session?.cwd).toBe('/srv/transcript-cwd')
    expect(session?.title).toBe('Transcript title')
    expect(session?.model).toBe('transcript-model')
    expect(session?.createdAt).toBe('2026-05-01T10:00:00.000Z')
  })

  it('drops a session the user hid in Devin', async () => {
    const dir = await tempDir('orca-devin-db-')
    const cliDir = join(dir, 'cli')
    const transcriptsDir = join(cliDir, 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    const filePath = join(transcriptsDir, 'apricot.json')
    const dbPath = join(cliDir, 'sessions.db')
    writeDevinSessionsDb(dbPath, [{ id: 'apricot', hidden: 1 }])

    const fold = devinFoldSession(filePath, {
      session_id: 'apricot',
      steps: []
    })
    const { session, refused } = await enrichSessionFromSidecar(
      devinCandidate(filePath, await sidecarOf(dbPath)),
      fold,
      'linux'
    )
    expect(session).toBeNull()
    expect(refused).toBe(false)
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

  it('still lists sessions when sessions.db is absent', async () => {
    const root = await tempDir('orca-devin-scan-')
    const transcriptsDir = join(root, 'devin-cli', 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    await writeFile(
      join(transcriptsDir, 'bare.json'),
      JSON.stringify({
        session_id: 'bare',
        working_directory: '/srv/bare',
        steps: []
      })
    )
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      devinTranscriptsDir: transcriptsDir
    })
    const devin = result.sessions.filter((session) => session.agent === 'devin')
    expect(devin.map((session) => session.sessionId)).toEqual(['bare'])
    expect(devin[0]?.cwd).toBe('/srv/bare')
  })

  it('picks up db-only changes on a rescan without the transcript moving', async () => {
    const root = await tempDir('orca-devin-scan-')
    const { transcriptsDir, dbPath } = await writeDevinVault(root)
    const options = {
      ...isolatedScanRoots(root),
      devinTranscriptsDir: transcriptsDir
    }
    await scanAiVaultSessions(options)

    // Unhide and retitle; bump mtime so the sidecar stat reads as changed even
    // on a coarse-granularity filesystem.
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
