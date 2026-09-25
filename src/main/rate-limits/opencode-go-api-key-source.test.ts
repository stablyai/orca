import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  getOpenCodeAuthFilePath,
  readOpenCodeAuthFileGoKey,
  resolveOpenCodeGoApiKey
} from './opencode-go-api-key-source'

// Placeholder values only — a real key must never reach a fixture.
const SETTINGS_KEY = 'settings-placeholder-key'
const ENVIRONMENT_KEY = 'environment-placeholder-key'
const AUTH_FILE_KEY = 'auth-file-placeholder-key'
const DATABASE_KEY = 'database-placeholder-key'

const ENVIRONMENT_KEYS = ['XDG_DATA_HOME', 'OPENCODE_API_KEY', 'OPENCODE_DB'] as const

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
    originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
    dataHome = mkdtempSync(join(tmpdir(), 'orca-opencode-go-key-'))
    process.env.XDG_DATA_HOME = dataHome
    delete process.env.OPENCODE_API_KEY
    // Keeps the credential-database tier from touching the developer's own store.
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

  it('reads auth.json from XDG_DATA_HOME, which OpenCode uses on every platform', () => {
    expect(getOpenCodeAuthFilePath({ XDG_DATA_HOME: '/data' })).toBe('/data/opencode/auth.json')
    // OpenCode's global-roots.ts falls back to os.homedir() + .local/share even on Windows.
    expect(getOpenCodeAuthFilePath({}, '/home/person')).toBe(
      join('/home/person', '.local', 'share', 'opencode', 'auth.json')
    )
  })

  it('prefers the settings override over every other tier', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })

    await expect(
      resolveOpenCodeGoApiKey({ settingsOverride: `  ${SETTINGS_KEY}  ` })
    ).resolves.toEqual({ status: 'found', key: SETTINGS_KEY, tier: 'settings' })
  })

  it('prefers the key OpenCode saved on /connect over OPENCODE_API_KEY, as OpenCode does', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })

    await expect(resolveOpenCodeGoApiKey({ settingsOverride: '   ' })).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('falls back to OPENCODE_API_KEY when OpenCode stored no key', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    writeAuthFile({ anthropic: { type: 'api', key: 'not-the-go-key' } })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('falls back to the key OpenCode 1.x saved on /connect when the table is empty', async () => {
    writeAuthFile({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      'opencode-go': { type: 'api', key: AUTH_FILE_KEY }
    })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('falls back to the OpenCode 2 credential table when auth.json has no entry', async () => {
    writeAuthFile({ anthropic: { type: 'api', key: 'not-the-go-key' } })
    const { path } = writeCredentialDatabase([
      {
        value: JSON.stringify({ type: 'key', key: 'stale-placeholder-key' }),
        active: 0,
        created: 2
      },
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: DATABASE_KEY,
      tier: 'opencode-credential-database'
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

  it('keeps the settings override above the credential table', async () => {
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({ settingsOverride: SETTINGS_KEY })).resolves.toEqual({
      status: 'found',
      key: SETTINGS_KEY,
      tier: 'settings'
    })
  })

  it('reports missing when no tier holds a key', async () => {
    writeAuthFile({ 'opencode-go': { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({ status: 'missing' })
  })

  it('treats a malformed auth file as "no key" rather than a failure', () => {
    mkdirSync(join(dataHome, 'opencode'), { recursive: true })
    writeFileSync(join(dataHome, 'opencode', 'auth.json'), '{not json')

    expect(readOpenCodeAuthFileGoKey(process.env)).toBeNull()
  })
})
