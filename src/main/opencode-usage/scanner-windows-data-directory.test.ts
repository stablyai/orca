import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { opencodeDiscoveries } from '../ai-vault/session-scanner-opencode-sources'
import { OpenCodeSqliteScanContext } from '../ai-vault/session-scanner-opencode-sqlite-scan-context'
import Database from '../sqlite/sync-database'
import { scanOpenCodeUsageDatabases } from './scanner'

vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const { listOpenCodeSqliteSessions } =
    await import('../ai-vault/session-scanner-opencode-sqlite-list')
  return { listOpenCodeSqliteSessionsViaWorker: listOpenCodeSqliteSessions }
})

describe('OpenCode usage discovery on Windows', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const environmentKeys = [
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'XDG_DATA_HOME',
    'OPENCODE_DB'
  ] as const
  let originalEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>
  let homeDirectory: string

  beforeEach(() => {
    originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
    homeDirectory = mkdtempSync(join(tmpdir(), 'orca-opencode-windows-home-'))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.HOME = homeDirectory
    process.env.USERPROFILE = homeDirectory
    process.env.LOCALAPPDATA = join(homeDirectory, 'AppData', 'Local')
    process.env.APPDATA = join(homeDirectory, 'AppData', 'Roaming')
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_DB
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    for (const key of environmentKeys) {
      const value = originalEnvironment[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(homeDirectory, { recursive: true, force: true })
  })

  it('loads a session from ~/.local/share instead of the Windows app-data directory', async () => {
    mkdirSync(process.env.LOCALAPPDATA!, { recursive: true })
    const dataDirectory = join(homeDirectory, '.local', 'share', 'opencode')
    mkdirSync(dataDirectory, { recursive: true })
    const databasePath = join(dataDirectory, 'opencode.db')
    const database = new Database(databasePath)
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        title TEXT,
        model TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        time_created INTEGER,
        time_updated INTEGER
      );
      INSERT INTO session VALUES (
        'windows-session', 'C:\\repo', 'Windows session',
        '{"providerID":"openai","id":"gpt-5"}', 0.01,
        100, 20, 0, 0, 1777777700000, 1777777800000
      );
    `)
    database.close()

    const result = await scanOpenCodeUsageDatabases([], [])
    const issues = []
    const context = new OpenCodeSqliteScanContext()
    const [discovery] = await Promise.all(
      opencodeDiscoveries({ platform: 'win32' }, [], 25, issues, context)
    )

    expect(discovery?.files.map(({ path }) => path)).toEqual([`${databasePath}#windows-session`])
    expect(issues).toEqual([])
    expect(result.processedDatabases.map(({ path }) => path)).toEqual([databasePath])
    expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(['windows-session'])
  })
})
