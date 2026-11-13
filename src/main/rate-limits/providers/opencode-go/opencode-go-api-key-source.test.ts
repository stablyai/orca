import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { detectOpenCodeCredentialBackend } from '../../../opencode/accounts/opencode-credential-backend'
import { resolveOpenCodeGoApiKey } from './opencode-go-api-key-source'

vi.mock('../../../opencode/accounts/opencode-credential-backend', () => ({
  detectOpenCodeCredentialBackend: vi.fn()
}))
const ENVIRONMENT_KEY = 'environment-placeholder-key'
const AUTH_FILE_KEY = 'auth-file-placeholder-key'
const DATABASE_KEY = 'database-placeholder-key'

const ENVIRONMENT_KEYS = [
  'XDG_DATA_HOME',
  'OPENCODE_API_KEY',
  'OPENCODE_DB',
  'OPENCODE_AUTH_CONTENT'
] as const

describe('resolveOpenCodeGoApiKey', () => {
  let dataHome: string
  let originalEnvironment: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>

  function writeAuthFile(contents: unknown): void {
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(join(dataHome, 'opencode', 'auth.json'), JSON.stringify(contents))
  }

  function writeCredentialDatabase(rows: { value: string; active: number; created: number }[]): {
    path: string
  } {
    const path = join(dataHome, 'opencode-credentials.db')
    const database = new Database(path)
    database.exec(
      'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, ' +
        'value TEXT, active INTEGER, time_created INTEGER)'
    )
    rows.forEach((row, index) => {
      database
        .prepare(
          'INSERT INTO credential (id, integration_id, label, value, active, time_created) ' +
            "VALUES (?, 'opencode-go', 'API key', ?, ?, ?)"
        )
        .run(`cred_${index}`, row.value, row.active, row.created)
    })
    database.close()
    return { path }
  }

  beforeEach(() => {
    vi.mocked(detectOpenCodeCredentialBackend).mockReset().mockResolvedValue('v2')
    originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
    dataHome = mkdtempSync(join(tmpdir(), 'orca-opencode-go-key-'))
    process.env.XDG_DATA_HOME = dataHome
    delete process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_AUTH_CONTENT
    // Isolate credential DB access from the developer's store.
    process.env.OPENCODE_DB = ':memory:'
  })

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(dataHome, { recursive: true, force: true })
  })

  it('does not fall back to OPENCODE_API_KEY when the credential database is unreadable', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    const path = join(dataHome, 'opencode-unreadable.db')
    writeFileSync(path, 'not a sqlite database')
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'credential-database-unreadable'
    })
  })

  it('prefers the credential table over a stale auth.json, since OpenCode 2 stops writing the file', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: DATABASE_KEY,
      tier: 'opencode-credential-database'
    })
  })

  it('uses v1 auth.json despite a conflicting populated credential table', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })
})
