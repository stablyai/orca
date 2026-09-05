import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../main/sqlite/sync-database'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import { buildRelayAiVaultServiceEnv } from '../main/ai-vault/session-scanner-service-env'

describe('SSH-owned MiMo discovery', () => {
  let home: string
  let dbPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-relay-mimo-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('MIMOCODE_HOME', join(home, 'mimo'))
    const data = join(home, 'mimo', 'data')
    mkdirSync(data, { recursive: true })
    dbPath = join(data, 'mimocode.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT, time_archived INTEGER
    )`)
    const insert = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL, NULL)')
    insert.run('recent', 'Recent MiMo', '/work/other', 2000, 3000)
    insert.run('scoped', 'Workspace MiMo', '/work/project', 1000, 1000)
    db.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  const scan = (options = {}) =>
    scanRemoteAiVaultSessions({
      provider: createRelayAiVaultFilesystemProvider(),
      executionHostId: 'ssh:dev',
      remoteHome: home,
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      agents: ['mimo-code'],
      limit: 1,
      ...options
    })

  it('reads the host database and returns an SSH-owned resumable session', async () => {
    const result = await scan()
    expect(result.issues).toEqual([])
    expect(result.sessions).toMatchObject([
      {
        agent: 'mimo-code',
        sessionId: 'recent',
        title: 'Recent MiMo',
        executionHostId: 'ssh:dev',
        executionHostPlatform: 'linux',
        filePath: dbPath,
        resumeCommand: "cd '/work/other' && mimo --session 'recent'"
      }
    ])
  })

  it('retains older workspace history outside the global recency cap', async () => {
    const result = await scan({ scopePaths: ['/work/project'] })
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['recent', 'scoped'])
  })

  it('does not query MiMo when the provider is disabled', async () => {
    const result = await scan({ agents: [] })
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('reads committed WAL sessions while the host writer remains open', async () => {
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(
      'wal-session',
      'Live WAL',
      '/work/live',
      4000,
      5000
    )
    try {
      const result = await scan()
      expect(result.issues).toEqual([])
      expect(result.sessions.map((session) => session.sessionId)).toEqual(['wal-session'])
    } finally {
      db.close()
    }
  })

  it('discovers XDG data on the execution host without MIMOCODE_HOME', async () => {
    vi.stubEnv('MIMOCODE_HOME', '')
    const data = join(home, 'xdg', 'mimocode')
    mkdirSync(data, { recursive: true })
    renameSync(dbPath, join(data, 'mimocode.db'))
    vi.stubEnv('XDG_DATA_HOME', join(home, 'xdg'))
    const result = await scan()
    expect(result.sessions.map((session) => [session.sessionId, session.filePath])).toEqual([
      ['recent', join(data, 'mimocode.db')]
    ])
  })

  it('rejects a cancelled scan before querying the database', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(scan({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports the limitation of a filesystem-only SSH provider', async () => {
    const provider = createRelayAiVaultFilesystemProvider()
    const result = await scan({
      provider: {
        readDir: provider.readDir,
        readFile: provider.readFile,
        stat: provider.stat
      }
    })
    expect(result.sessions).toEqual([])
    expect(result.issues).toMatchObject([
      {
        agent: 'mimo-code',
        kind: 'scope',
        message: expect.stringContaining('host-side SQLite support')
      }
    ])
  })

  it('reports unavailable host SQLite support instead of a successful empty scan', async () => {
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      throw new Error('node:sqlite is unavailable in this Node.js runtime')
    })
    const result = await scan()
    expect(result.sessions).toEqual([])
    expect(result.issues).toMatchObject([
      {
        agent: 'mimo-code',
        kind: 'scope',
        path: dbPath,
        message: expect.stringContaining('node:sqlite is unavailable')
      }
    ])
  })

  it('preserves host MiMo locations in the isolated sidecar environment', () => {
    expect(
      buildRelayAiVaultServiceEnv(
        {
          MIMOCODE_HOME: '/host/mimo',
          XDG_DATA_HOME: '/host/data',
          NODE_OPTIONS: '--inspect'
        },
        'linux'
      )
    ).toEqual({ MIMOCODE_HOME: '/host/mimo', XDG_DATA_HOME: '/host/data' })
  })
})
