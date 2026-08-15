import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ManagedCliHomeProvider } from '../../shared/managed-account-types'
import { ManagedCliHomeAccountService } from './service'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-provider-homes-'))
  roots.push(root)
  return root
}

function createStore() {
  let settings = getDefaultSettings('/home/test')
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
}

function createSource(root: string, provider: ManagedCliHomeProvider): string {
  const source = join(root, `${provider}-source`)
  mkdirSync(source, { recursive: true, mode: 0o700 })
  if (provider === 'grok') {
    writeFileSync(
      join(source, 'auth.json'),
      JSON.stringify({ 'https://auth.x.ai': { key: 'grok-secret', email: 'a@example.com' } }),
      { mode: 0o600 }
    )
    writeFileSync(join(source, 'config.toml'), 'mcp_token = "do-not-copy"', { mode: 0o600 })
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'sessions', 'chat.json'), 'private chat')
  } else {
    mkdirSync(join(source, '.gemini'), { mode: 0o700 })
    writeFileSync(
      join(source, '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expiry_date: 1 }),
      { mode: 0o600 }
    )
    writeFileSync(
      join(source, '.gemini', 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: { private: { env: { TOKEN: 'do-not-copy' } } }
      }),
      { mode: 0o600 }
    )
    mkdirSync(join(source, '.gemini', 'tmp'))
    writeFileSync(join(source, '.gemini', 'tmp', 'chat.json'), 'private chat')
  }
  return source
}

function createService(
  store: ReturnType<typeof createStore>,
  root: string,
  provider: ManagedCliHomeProvider
) {
  return new ManagedCliHomeAccountService(store, provider, join(root, 'managed', provider))
}

describe.each(['grok', 'gemini'] as const)('ManagedCliHomeAccountService: %s', (provider) => {
  it('imports only the bounded credential scope and returns path-free summaries', async () => {
    const root = tempRoot()
    const store = createStore()
    const state = await createService(store, root, provider).addAccountFromHome(
      createSource(root, provider),
      'Work'
    )

    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]).toMatchObject({ provider, label: 'Work' })
    expect(state.accounts[0]).not.toHaveProperty('managedHomePath')
    const stored =
      provider === 'grok'
        ? store.getSettings().grokManagedAccounts![0]
        : store.getSettings().geminiManagedAccounts![0]
    const secretMarkers = provider === 'grok' ? ['grok-secret'] : ['access', 'refresh']
    for (const marker of secretMarkers) {
      expect(JSON.stringify(state)).not.toContain(marker)
    }
    expect(
      readFileSync(join(stored.managedHomePath, '.orca-managed-provider-account'), 'utf-8')
    ).toBe(`${provider}:${stored.id}\n`)
    if (provider === 'grok') {
      expect(() => statSync(join(stored.managedHomePath, 'config.toml'))).toThrow()
    } else {
      const managedSettings = JSON.parse(
        readFileSync(join(stored.managedHomePath, '.gemini', 'settings.json'), 'utf-8')
      )
      expect(managedSettings).toEqual({
        security: { auth: { selectedType: 'oauth-personal' } }
      })
      expect(JSON.stringify(managedSettings)).not.toContain('do-not-copy')
    }
    const sessionPath =
      provider === 'grok'
        ? join(stored.managedHomePath, 'sessions')
        : join(stored.managedHomePath, '.gemini', 'tmp')
    expect(() => statSync(sessionPath)).toThrow()
  })

  it('selects and removes only the managed copy', async () => {
    const root = tempRoot()
    const source = createSource(root, provider)
    const store = createStore()
    const service = createService(store, root, provider)
    const added = await service.addAccountFromHome(source, 'Work')
    const accountId = added.accounts[0].id
    const managedHome = service.getSelectedManagedHomePath()!

    expect((await service.selectAccount(null)).activeAccountId).toBeNull()
    expect(service.getSelectedManagedHomePath()).toBeNull()
    expect((await service.selectAccount(accountId)).activeAccountId).toBe(accountId)
    expect((await service.removeAccount(accountId)).accounts).toEqual([])
    expect(() => statSync(managedHome)).toThrow()
    expect(statSync(source).isDirectory()).toBe(true)
  })

  it('rejects invalid labels and malformed credentials', async () => {
    const root = tempRoot()
    const source = createSource(root, provider)
    const authPath =
      provider === 'grok' ? join(source, 'auth.json') : join(source, '.gemini', 'oauth_creds.json')
    writeFileSync(authPath, '{}')

    await expect(
      createService(createStore(), root, provider).addAccountFromHome(source, 'Work')
    ).rejects.toThrow(/valid|signed-in/i)
    await expect(
      createService(createStore(), root, provider).addAccountFromHome(source, 'line\nbreak')
    ).rejects.toThrow(/label/i)
  })

  it('rejects credential files above the bounded-copy limit', async () => {
    const root = tempRoot()
    const source = createSource(root, provider)
    const authPath =
      provider === 'grok' ? join(source, 'auth.json') : join(source, '.gemini', 'oauth_creds.json')
    writeFileSync(authPath, Buffer.alloc(1024 * 1024 + 1, 0x61))

    await expect(
      createService(createStore(), root, provider).addAccountFromHome(source, 'Work')
    ).rejects.toThrow(/1 MB safety limit/i)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link credential directory',
    async () => {
      const root = tempRoot()
      const source = createSource(root, provider)
      if (provider === 'gemini') {
        const { renameSync } = await import('node:fs')
        const realGemini = join(source, '.gemini')
        const outside = join(root, 'outside-gemini')
        renameSync(realGemini, outside)
        symlinkSync(outside, realGemini, 'dir')
      } else {
        const { mkdirSync: mkdir, renameSync } = await import('node:fs')
        const grokDir = join(source, '.grok')
        mkdir(grokDir, { recursive: true })
        renameSync(join(source, 'auth.json'), join(grokDir, 'auth.json'))
        const outside = join(root, 'outside-grok')
        renameSync(grokDir, outside)
        symlinkSync(outside, grokDir, 'dir')
      }

      await expect(
        createService(createStore(), root, provider).addAccountFromHome(source, 'Work')
      ).rejects.toThrow(/symbolic link/i)
    }
  )

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link source home', async () => {
    const root = tempRoot()
    const source = createSource(root, provider)
    const sourceLink = join(root, `${provider}-source-link`)
    symlinkSync(source, sourceLink, 'dir')

    await expect(
      createService(createStore(), root, provider).addAccountFromHome(sourceLink, 'Work')
    ).rejects.toThrow(/symbolic link/i)
  })
})
