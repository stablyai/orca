import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslTranscriptFsAccess from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-error'
import Database from '../sqlite/sync-database'
import { detectOpenCodeCredentialBackend } from '../opencode/opencode-credential-backend'
import {
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from '../opencode-usage/opencode-database-discovery'
import {
  getOpenCodeAuthFilePath,
  readOpenCodeAuthFileGoKey,
  resolveOpenCodeGoApiKey
} from './opencode-go-api-key-source'

vi.mock('../opencode/opencode-credential-backend', () => ({
  detectOpenCodeCredentialBackend: vi.fn()
}))

// Placeholder values only — a real key must never reach a fixture.
const SETTINGS_KEY = 'settings-placeholder-key'
const ENVIRONMENT_KEY = 'environment-placeholder-key'
const AUTH_FILE_KEY = 'auth-file-placeholder-key'
const DATABASE_KEY = 'database-placeholder-key'

const ENVIRONMENT_KEYS = [
  'XDG_DATA_HOME',
  'OPENCODE_API_KEY',
  'OPENCODE_DB',
  'OPENCODE_AUTH_CONTENT'
] as const

// Lets a test fail the data-directory listing with an error the host filesystem cannot portably produce.
const readdirFailure = vi.hoisted((): { error: unknown } => ({ error: null }))
vi.mock('../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
  const actual = await importOriginal<typeof WslTranscriptFsAccess>()
  return {
    ...actual,
    wslGatedReaddir: (...args: Parameters<typeof actual.wslGatedReaddir>) =>
      readdirFailure.error ? Promise.reject(readdirFailure.error) : actual.wslGatedReaddir(...args)
  }
})

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
    // Keeps the credential-database tier from touching the developer's own store.
    process.env.OPENCODE_DB = ':memory:'
  })

  afterEach(() => {
    readdirFailure.error = null
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

  it.each([undefined, 'selected.db'] as const)(
    'uses the fourth-argument environment for discovery (%s)',
    async (override) => {
      const directory = join(dataHome, 'opencode')
      mkdirSync(directory)
      const path = join(directory, override ?? 'opencode.db')
      writeFileSync(path, '')
      const onFsError = vi.fn()

      await expect(
        listOpenCodeDatabases(undefined, onFsError, undefined, {
          XDG_DATA_HOME: dataHome,
          OPENCODE_DB: override
        })
      ).resolves.toEqual([path])
      expect(onFsError).not.toHaveBeenCalled()
      expect(process.env.OPENCODE_DB).toBe(':memory:')
    }
  )

  it('keeps filesystem error reporting in the second argument', async () => {
    const error = Object.assign(new Error('discovery denied'), { code: 'EACCES' })
    readdirFailure.error = error
    const onFsError = vi.fn()

    await expect(
      listOpenCodeDatabases(undefined, onFsError, undefined, { XDG_DATA_HOME: dataHome })
    ).resolves.toEqual([])
    expect(onFsError).toHaveBeenCalledWith(join(dataHome, 'opencode'), error)
  })

  it.each([undefined, 'missing.db'] as const)(
    'preserves third-argument cancellation before reporting discovery errors (%s)',
    async (override) => {
      readdirFailure.error = new Error('discovery stopped')
      const reason = new Error('caller cancelled')
      const controller = new AbortController()
      controller.abort(reason)
      const onFsError = vi.fn()

      await expect(
        listOpenCodeDatabases(undefined, onFsError, controller.signal, {
          XDG_DATA_HOME: dataHome,
          OPENCODE_DB: override
        })
      ).rejects.toBe(reason)
      expect(onFsError).not.toHaveBeenCalled()
    }
  )

  it('preserves the native directory helper cancellation and error argument positions', async () => {
    readdirFailure.error = new Error('directory read stopped')
    const reason = new Error('caller cancelled')
    const controller = new AbortController()
    controller.abort(reason)
    const onFsError = vi.fn()

    await expect(
      listOpenCodeDatabasesInDirectory(dataHome, undefined, controller.signal, onFsError)
    ).rejects.toBe(reason)
    expect(onFsError).not.toHaveBeenCalled()
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

  it('uses the key OpenCode 1.x saved on /connect', async () => {
    writeAuthFile({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      'opencode-go': { type: 'api', key: AUTH_FILE_KEY }
    })

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
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

  it('does not fall back to OPENCODE_API_KEY when the credential database is unreadable', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    const path = join(dataHome, 'opencode-unreadable.db')
    writeFileSync(path, 'not a sqlite database')
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'credential-database-unreadable'
    })
  })

  it('does not fall back to OPENCODE_API_KEY when the data directory cannot be listed', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    delete process.env.OPENCODE_DB
    readdirFailure.error = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'credential-database-unreadable'
    })
  })

  it('still falls back to OPENCODE_API_KEY when the data directory does not exist', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    delete process.env.OPENCODE_DB

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('still falls back to OPENCODE_API_KEY when the WSL gate refuses the listing', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    delete process.env.OPENCODE_DB
    readdirFailure.error = new WslTranscriptFsError('timeout', 'slow')

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('reports missing for an unreadable database when no env key could be misused', async () => {
    const path = join(dataHome, 'opencode-unreadable.db')
    writeFileSync(path, 'not a sqlite database')
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({ status: 'missing' })
  })

  it('still falls back to OPENCODE_API_KEY when a readable database holds no Go key', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    const { path } = writeCredentialDatabase([])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('prefers a database key over OPENCODE_API_KEY', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
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

  it('does not use a v2 table-only credential for v1 execution', async () => {
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    const { path } = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ])
    process.env.OPENCODE_DB = path

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('applies the installed v1 backend even when the table has a key', async () => {
    vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue('v1')
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    process.env.OPENCODE_DB = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ]).path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('uses v1 inline authentication ahead of a conflicting auth file and table', async () => {
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    process.env.OPENCODE_DB = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ]).path
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      'opencode-go': { type: 'api', key: 'inline-placeholder-key' }
    })

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
      status: 'found',
      key: 'inline-placeholder-key',
      tier: 'opencode-auth-content'
    })
  })

  it('does not fall back to the auth file when valid v1 inline auth omits Go', async () => {
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    process.env.OPENCODE_AUTH_CONTENT = '{}'
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
  })

  it('uses the v1 auth file after malformed inline authentication', async () => {
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    process.env.OPENCODE_AUTH_CONTENT = '{invalid'

    await expect(resolveOpenCodeGoApiKey({ backend: 'v1' })).resolves.toEqual({
      status: 'found',
      key: AUTH_FILE_KEY,
      tier: 'opencode-auth-file'
    })
  })

  it('withholds stored credentials when the execution backend cannot be determined', async () => {
    vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(null)
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    process.env.OPENCODE_DB = writeCredentialDatabase([
      { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
    ]).path

    await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({ status: 'missing' })
  })

  it('uses the provided environment key without reading stores when the backend is unknown', async () => {
    vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(null)
    const environment: NodeJS.ProcessEnv = { OPENCODE_API_KEY: `  ${ENVIRONMENT_KEY}  ` }
    const readStoreContext = vi.fn(() => {
      throw new Error('Unknown backend must not read version-specific stores')
    })
    for (const name of ['OPENCODE_AUTH_CONTENT', 'XDG_DATA_HOME', 'OPENCODE_DB']) {
      Object.defineProperty(environment, name, { get: readStoreContext })
    }

    await expect(resolveOpenCodeGoApiKey({ environment, cwd: dataHome })).resolves.toEqual({
      status: 'found',
      key: ENVIRONMENT_KEY,
      tier: 'environment'
    })
    expect(vi.mocked(detectOpenCodeCredentialBackend).mock.calls[0]?.[0]).toBe(environment)
    expect(vi.mocked(detectOpenCodeCredentialBackend).mock.calls[0]?.[1]).toBe(dataHome)
    expect(readStoreContext).not.toHaveBeenCalled()
  })

  it.each([undefined, '', ' \t\n '])(
    'does not borrow the host key when an unknown selected backend has environment key %j',
    async (key) => {
      vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(null)
      process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
      const environment: NodeJS.ProcessEnv = { OPENCODE_API_KEY: key }

      await expect(resolveOpenCodeGoApiKey({ environment })).resolves.toEqual({ status: 'missing' })
      expect(detectOpenCodeCredentialBackend).toHaveBeenCalledWith(environment, undefined)
    }
  )

  it('keeps host and selected environment keys isolated when the backend is unknown', async () => {
    vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(null)
    process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
    const selected = { OPENCODE_API_KEY: 'selected-environment-placeholder' }
    const inherited = { ...process.env }

    const first = await resolveOpenCodeGoApiKey({})
    const managed = await resolveOpenCodeGoApiKey({ environment: selected })
    const restored = await resolveOpenCodeGoApiKey({})

    expect(first).toEqual({ status: 'found', key: ENVIRONMENT_KEY, tier: 'environment' })
    expect(managed).toEqual({
      status: 'found',
      key: 'selected-environment-placeholder',
      tier: 'environment'
    })
    expect(restored).toEqual(first)
    expect(process.env).toEqual(inherited)
    expect(selected).toEqual({ OPENCODE_API_KEY: 'selected-environment-placeholder' })
  })

  it.each(['v1', 'v2'] as const)(
    'uses caller backend authority for %s without probing',
    async (backend) => {
      vi.mocked(detectOpenCodeCredentialBackend).mockRejectedValue(new Error('Unexpected probe'))
      process.env.OPENCODE_API_KEY = ENVIRONMENT_KEY
      writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
      process.env.OPENCODE_DB = writeCredentialDatabase([
        { value: JSON.stringify({ type: 'key', key: DATABASE_KEY }), active: 1, created: 1 }
      ]).path

      await expect(resolveOpenCodeGoApiKey({ backend })).resolves.toEqual(
        backend === 'v1'
          ? { status: 'found', key: AUTH_FILE_KEY, tier: 'opencode-auth-file' }
          : { status: 'found', key: DATABASE_KEY, tier: 'opencode-credential-database' }
      )
      expect(detectOpenCodeCredentialBackend).not.toHaveBeenCalled()
    }
  )

  it('returns the manual override before reading execution context or probing a CLI', async () => {
    const input = { settingsOverride: SETTINGS_KEY }
    Object.defineProperty(input, 'environment', {
      get: () => {
        throw new Error('Selected profile metadata is unreadable')
      }
    })
    vi.mocked(detectOpenCodeCredentialBackend).mockRejectedValue(new Error('Unexpected probe'))

    await expect(resolveOpenCodeGoApiKey(input)).resolves.toEqual({
      status: 'found',
      key: SETTINGS_KEY,
      tier: 'settings'
    })
    expect(detectOpenCodeCredentialBackend).not.toHaveBeenCalled()
  })

  it('propagates unreadable selected context instead of reading host credentials', async () => {
    writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
    const input = {}
    Object.defineProperty(input, 'environment', {
      get: () => {
        throw new Error('Selected profile metadata is unreadable')
      }
    })

    await expect(resolveOpenCodeGoApiKey(input)).rejects.toThrow(
      'Selected profile metadata is unreadable'
    )
  })

  it.each(['v1', 'v2'] as const)(
    'keeps System and selected data roots isolated for %s',
    async (backend) => {
      writeAuthFile({ 'opencode-go': { type: 'api', key: AUTH_FILE_KEY } })
      const system = { XDG_DATA_HOME: dataHome, OPENCODE_DB: ':memory:' }
      const selectedDataHome = join(dataHome, 'selected')
      mkdirSync(join(selectedDataHome, 'opencode'), { recursive: true })
      writeFileSync(
        join(selectedDataHome, 'opencode', 'auth.json'),
        JSON.stringify({
          'opencode-go': { type: 'api', key: 'selected-auth-placeholder' }
        })
      )
      const { path } = writeCredentialDatabase([
        {
          value: JSON.stringify({ type: 'key', key: 'selected-table-placeholder' }),
          active: 1,
          created: 1
        }
      ])
      const selected = { XDG_DATA_HOME: selectedDataHome, OPENCODE_DB: path }
      const inherited = { ...process.env }

      const first = await resolveOpenCodeGoApiKey({ environment: system, backend })
      const managed = await resolveOpenCodeGoApiKey({ environment: selected, backend })
      const restored = await resolveOpenCodeGoApiKey({ environment: system, backend })

      expect(first).toEqual({ status: 'found', key: AUTH_FILE_KEY, tier: 'opencode-auth-file' })
      expect(managed).toEqual(
        backend === 'v1'
          ? { status: 'found', key: 'selected-auth-placeholder', tier: 'opencode-auth-file' }
          : {
              status: 'found',
              key: 'selected-table-placeholder',
              tier: 'opencode-credential-database'
            }
      )
      expect(restored).toEqual(first)
      expect(process.env).toEqual(inherited)
    }
  )

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
