import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const [{ listHermesSqliteSessions }, { parseHermesSqliteSession }] = await Promise.all([
    import('./session-scanner-hermes-sqlite-list'),
    import('./session-scanner-hermes-sqlite')
  ])
  return {
    listOpenCodeSqliteSessionsViaWorker: vi.fn(async () => []),
    parseOpenCodeSqliteSessionViaWorker: vi.fn(async () => null),
    listHermesSqliteSessionsViaWorker: listHermesSqliteSessions,
    parseHermesSqliteSessionViaWorker: parseHermesSqliteSession
  }
})

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  vi.unstubAllEnvs()
})

describe('Hermes profile provenance', () => {
  it('preserves named profile provenance for legacy JSON sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-hermes-profile-'))
    tempRoots.push(root)
    const hermesHomeDir = join(root, 'hermes-home')
    const sessionsDir = join(hermesHomeDir, 'profiles', 'work', 'sessions')
    const {
      hermesDbPaths: _hermesDbPaths,
      hermesSessionsDir: _hermesSessionsDir,
      ...scanRoots
    } = isolatedScanRoots(root)
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session_named-profile.json'),
      JSON.stringify({
        session_id: 'named-profile',
        cwd: '/tmp/hermes',
        session_start: '2026-05-01T10:00:00.000Z',
        last_updated: '2026-05-01T10:00:01.000Z',
        messages: [{ role: 'user', content: 'Named profile legacy session' }]
      })
    )

    const result = await scanAiVaultSessions({
      ...scanRoots,
      hermesHomeDir,
      platform: 'linux'
    })
    const session = result.sessions.find(
      (candidate) => candidate.agent === 'hermes' && candidate.sessionId === 'named-profile'
    )

    expect(result.issues.filter((issue) => issue.agent !== 'hermes')).toEqual([])
    expect(session).toMatchObject({
      profileName: 'work',
      resumeCommand: "cd '/tmp/hermes' && hermes -p 'work' --resume 'named-profile'"
    })
  })

  it('treats direct HERMES_HOME profile paths as named profiles and discovers default and siblings once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-hermes-direct-profile-'))
    tempRoots.push(root)
    const baseHome = join(root, 'hermes-home')
    const directProfileHome = join(baseHome, 'profiles', 'work')
    const {
      hermesDbPaths: _hermesDbPaths,
      hermesSessionsDir: _hermesSessionsDir,
      ...scanRoots
    } = isolatedScanRoots(root)

    const sessions = [
      { directory: join(baseHome, 'sessions'), id: 'default-session', profileName: undefined },
      { directory: join(directProfileHome, 'sessions'), id: 'work-session', profileName: 'work' },
      {
        directory: join(baseHome, 'profiles', 'other', 'sessions'),
        id: 'other-session',
        profileName: 'other'
      }
    ]
    for (const session of sessions) {
      await mkdir(session.directory, { recursive: true })
      await writeFile(
        join(session.directory, `session_${session.id}.json`),
        JSON.stringify({
          session_id: session.id,
          cwd: `/tmp/${session.id}`,
          session_start: '2026-05-01T10:00:00.000Z',
          last_updated: '2026-05-01T10:00:01.000Z',
          messages: [{ role: 'user', content: session.id }]
        })
      )
    }

    const result = await scanAiVaultSessions({
      ...scanRoots,
      hermesHomeDir: directProfileHome,
      platform: 'linux'
    })
    const hermesSessions = result.sessions.filter((session) => session.agent === 'hermes')

    expect(hermesSessions.map((session) => session.sessionId).sort()).toEqual([
      'default-session',
      'other-session',
      'work-session'
    ])
    expect(
      hermesSessions.map((session) => [session.sessionId, session.profileName]).sort()
    ).toEqual([
      ['default-session', 'default'],
      ['other-session', 'other'],
      ['work-session', 'work']
    ])
    expect(
      hermesSessions.find((session) => session.sessionId === 'work-session')?.resumeCommand
    ).toBe("cd '/tmp/work-session' && hermes -p 'work' --resume 'work-session'")
  })

  it('preserves direct HERMES_HOME profile provenance for SQLite sessions and resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-hermes-direct-sqlite-profile-'))
    tempRoots.push(root)
    const directProfileHome = join(root, 'hermes-home', 'profiles', 'work')
    const {
      hermesDbPaths: _hermesDbPaths,
      hermesSessionsDir: _hermesSessionsDir,
      ...scanRoots
    } = isolatedScanRoots(root)
    await mkdir(directProfileHome, { recursive: true })
    const dbPath = join(directProfileHome, 'state.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        title TEXT,
        cwd TEXT,
        model TEXT,
        message_count INTEGER DEFAULT 0
      )
    `)
    db.prepare(
      `INSERT INTO sessions (id, source, started_at, ended_at, title, cwd, model, message_count)
       VALUES (?, 'tui', ?, ?, ?, ?, ?, ?)`
    ).run(
      'direct-sqlite-session',
      1_784_000_000_000,
      1_784_000_001_000,
      'Direct profile',
      '/tmp/direct-sqlite',
      'model',
      2
    )
    db.close()

    const result = await scanAiVaultSessions({
      ...scanRoots,
      hermesHomeDir: directProfileHome,
      platform: 'linux'
    })
    const session = result.sessions.find(
      (candidate) => candidate.sessionId === 'direct-sqlite-session'
    )

    expect(session).toMatchObject({
      profileName: 'work',
      resumeCommand: "cd '/tmp/direct-sqlite' && hermes -p 'work' --resume 'direct-sqlite-session'"
    })
  })

  it('uses the default Hermes sessions directory when an injected DB path list is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-hermes-empty-db-paths-'))
    tempRoots.push(root)
    const hermesHome = join(root, '.hermes')
    const sessionsDir = join(hermesHome, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session_empty-db-paths.json'),
      JSON.stringify({ session_id: 'empty-db-paths', messages: [] })
    )
    vi.stubEnv('HERMES_HOME', hermesHome)
    vi.resetModules()
    const { hermesDiscoveries } = await import('./session-scanner-hermes-sources')

    const discoveries = await Promise.all(hermesDiscoveries({ hermesDbPaths: [] }, [], 10, []))

    expect(discoveries[0]?.rootDir).toBe(sessionsDir)
    expect(discoveries[0]?.files.map((file) => file.path)).toContain(
      join(sessionsDir, 'session_empty-db-paths.json')
    )
  })
})
