import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { detectOpenCodeCredentialBackend } from '../opencode/opencode-credential-backend'
import Database from '../sqlite/sync-database'
import { resolveOpenCodeGoApiKey } from './opencode-go-api-key-source'

vi.mock('../opencode/opencode-credential-backend', () => ({
  detectOpenCodeCredentialBackend: vi.fn()
}))

let root: string
let systemDataHome: string
let metadataPath: string

function writeCredentials(dataHome: string, name: string): void {
  const directory = join(dataHome, 'opencode')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'auth.json'),
    JSON.stringify({ 'opencode-go': { type: 'api', key: `${name}-auth-placeholder` } })
  )
  const database = new Database(join(directory, 'opencode.db'))
  try {
    database.exec(
      'CREATE TABLE session (id TEXT); ' +
        'CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)'
    )
    database
      .prepare('INSERT INTO credential VALUES (?, ?, 1, 1)')
      .run('opencode-go', JSON.stringify({ type: 'key', key: `${name}-table-placeholder` }))
  } finally {
    database.close()
  }
}

async function enrollSelectedAccount(): Promise<string> {
  const accounts = getManagedDataAccountService()
  const source = join(root, 'source')
  writeCredentials(source, 'selected')
  const state = await accounts.add('opencode', source, 'Selected')
  const selected = accounts.launchEnvironment('opencode')
  writeFileSync(
    join(selected.XDG_DATA_HOME, 'opencode', 'auth.json'),
    readFileSync(join(source, 'opencode', 'auth.json'))
  )
  await accounts.select('opencode', null)
  return state.accounts[0].id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-go-managed-caller-'))
  systemDataHome = join(root, 'system-data')
  const original = getAppEnvironment()
  setAppEnvironment({
    ...original,
    getPath: (name) => (name === 'userData' ? root : original.getPath(name))
  })
  metadataPath = join(root, 'managed-data-accounts', 'opencode', 'accounts.json')
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORCA_DATA_ACCOUNT_')) {
      vi.stubEnv(key, undefined)
    }
  }
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('XDG_DATA_HOME', systemDataHome)
  vi.stubEnv('XDG_STATE_HOME', join(root, 'system-state'))
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'))
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'))
  vi.stubEnv('OPENCODE_DB', 'opencode.db')
  vi.stubEnv('OPENCODE_AUTH_CONTENT', undefined)
  vi.stubEnv('OPENCODE_API_KEY', undefined)
  vi.mocked(detectOpenCodeCredentialBackend).mockReset()
  writeCredentials(systemDataHome, 'system')
})

afterEach(() => {
  vi.restoreAllMocks()
  getManagedDataAccountService().clearInlineAuthBaselines()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode Go execution-host managed account lookup', () => {
  it.each(['v1', 'v2'] as const)(
    'uses System → selected → System credentials on %s',
    async (backend) => {
      vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(backend)
      const id = await enrollSelectedAccount()
      const accounts = getManagedDataAccountService()
      const inherited = { ...process.env }
      const tier = backend === 'v1' ? 'opencode-auth-file' : 'opencode-credential-database'
      const suffix = backend === 'v1' ? 'auth' : 'table'

      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
        status: 'found',
        key: `system-${suffix}-placeholder`,
        tier
      })
      await accounts.select('opencode', id)
      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
        status: 'found',
        key: `selected-${suffix}-placeholder`,
        tier
      })
      expect(detectOpenCodeCredentialBackend).toHaveBeenLastCalledWith(
        expect.objectContaining(accounts.launchEnvironment('opencode')),
        undefined
      )
      await accounts.select('opencode', null)
      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
        status: 'found',
        key: `system-${suffix}-placeholder`,
        tier
      })
      expect(process.env).toEqual(inherited)
    }
  )

  it.each(['v1', 'v2'] as const)(
    'restores an opaque inline System baseline through the host service on %s',
    async (backend) => {
      vi.mocked(detectOpenCodeCredentialBackend).mockResolvedValue(backend)
      const id = await enrollSelectedAccount()
      const accounts = getManagedDataAccountService()
      await accounts.select('opencode', id)
      const selected = accounts.launchEnvironment('opencode')
      const inline = JSON.stringify({
        'opencode-go': { type: 'api', key: 'system-inline-placeholder' }
      })
      const baseline: Record<string, string> = {
        XDG_DATA_HOME: systemDataHome,
        XDG_STATE_HOME: join(root, 'system-state'),
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: inline
      }
      accounts.captureOriginalEnvironment(baseline, selected)
      const inheritedProfile: Record<string, string> = {
        ...baseline,
        ...selected,
        ORCA_DATA_ACCOUNT_PROVIDER: 'opencode',
        ORCA_DATA_ACCOUNT_DATA_HOME: selected.XDG_DATA_HOME,
        ORCA_DATA_ACCOUNT_STATE_HOME: selected.XDG_STATE_HOME
      }
      expect(inheritedProfile.ORCA_DATA_ACCOUNT_ORIGINAL_ENV).not.toContain(
        'system-inline-placeholder'
      )
      expect(JSON.parse(baseline.ORCA_DATA_ACCOUNT_ORIGINAL_ENV)).toMatchObject({
        OPENCODE_AUTH_CONTENT: null,
        inlineAuthReference: expect.any(String)
      })
      for (const [key, value] of Object.entries(inheritedProfile)) {
        vi.stubEnv(key, value)
      }
      const inherited = { ...process.env }

      await accounts.select('opencode', null)
      const expected =
        backend === 'v1'
          ? { status: 'found', key: 'system-inline-placeholder', tier: 'opencode-auth-content' }
          : {
              status: 'found',
              key: 'system-table-placeholder',
              tier: 'opencode-credential-database'
            }
      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual(expected)
      await accounts.select('opencode', id)
      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual({
        status: 'found',
        key: backend === 'v1' ? 'selected-auth-placeholder' : 'selected-table-placeholder',
        tier: backend === 'v1' ? 'opencode-auth-file' : 'opencode-credential-database'
      })
      await accounts.select('opencode', null)
      await expect(resolveOpenCodeGoApiKey({})).resolves.toEqual(expected)
      expect(process.env).toEqual(inherited)
    }
  )

  it.each(['malformed', 'unknown', 'unreadable'] as const)(
    'rejects %s metadata before probing or falling back, while a manual key still wins',
    async (failure) => {
      mkdirSync(join(root, 'managed-data-accounts', 'opencode'), { recursive: true })
      if (failure === 'unreadable') {
        mkdirSync(metadataPath)
      } else {
        writeFileSync(
          metadataPath,
          failure === 'malformed'
            ? '{invalid'
            : JSON.stringify({
                accounts: [],
                activeAccountId: randomUUID()
              })
        )
      }
      const before = failure === 'unreadable' ? null : readFileSync(metadataPath, 'utf8')
      const accounts = getManagedDataAccountService()
      const restore = vi.spyOn(accounts, 'restoreOriginalEnvironment')
      const selection = vi.spyOn(accounts, 'launchEnvironment')
      const inherited = { ...process.env }

      await expect(
        resolveOpenCodeGoApiKey({ settingsOverride: ' manual-placeholder ' })
      ).resolves.toEqual({
        status: 'found',
        key: 'manual-placeholder',
        tier: 'settings'
      })
      expect(restore).not.toHaveBeenCalled()
      expect(selection).not.toHaveBeenCalled()
      expect(process.env).toEqual(inherited)
      await expect(resolveOpenCodeGoApiKey({})).rejects.toThrow()
      expect(detectOpenCodeCredentialBackend).not.toHaveBeenCalled()
      if (before !== null) {
        expect(readFileSync(metadataPath, 'utf8')).toBe(before)
      }
      expect(process.env).toEqual(inherited)
    }
  )

  it('returns a manual key without resolving the host service or mutating the inherited environment', async () => {
    const inherited = { ...process.env }
    vi.spyOn(getAppEnvironment(), 'getPath').mockImplementation(() => {
      throw new Error('Host metadata must not be resolved')
    })
    await expect(
      resolveOpenCodeGoApiKey({ settingsOverride: 'manual-placeholder' })
    ).resolves.toEqual({
      status: 'found',
      key: 'manual-placeholder',
      tier: 'settings'
    })
    expect(detectOpenCodeCredentialBackend).not.toHaveBeenCalled()
    expect(process.env).toEqual(inherited)
    vi.restoreAllMocks()
  })
})
