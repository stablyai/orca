import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getDefaultSettings } from '../../shared/constants'
import { KimiAccountService } from './service'
import type { KimiLoginInstructionHandler } from './login-runner'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-kimi-accounts-'))
  roots.push(root)
  return root
}

function createStore(overrides: Partial<GlobalSettings> = {}) {
  let settings = { ...getDefaultSettings('/home/test'), ...overrides }
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
}

function createSourceHome(root: string): string {
  const home = join(root, 'source-home')
  mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'config.toml'), 'default_model = "kimi-k2.6"\n', { mode: 0o600 })
  writeFileSync(join(home, 'credentials', 'kimi-code.json'), '{"access_token":"secret"}', {
    mode: 0o600
  })
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'history.jsonl'), 'private session')
  return home
}

function createService(store: ReturnType<typeof createStore>, root: string): KimiAccountService {
  return new KimiAccountService(store, join(root, 'managed'), () => ({
    state: 'installed',
    detail: null
  }))
}

describe('KimiAccountService', () => {
  it('imports only config and credentials, and exposes no managed path or secret', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = createService(store, root)

    const snapshot = await service.addAccountFromHome(createSourceHome(root), 'Work')

    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.accounts[0]).toMatchObject({ label: 'Work', managedHomeRuntime: 'host' })
    expect(snapshot.accounts[0]).not.toHaveProperty('managedHomePath')
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    const stored = store.getSettings().kimiManagedAccounts![0]
    expect(readFileSync(join(stored.managedHomePath, 'config.toml'), 'utf-8')).toContain(
      'kimi-k2.6'
    )
    expect(
      readFileSync(join(stored.managedHomePath, 'credentials', 'kimi-code.json'), 'utf-8')
    ).toContain('secret')
    expect(() => statSync(join(stored.managedHomePath, 'sessions'))).toThrow()
    expect(
      readFileSync(join(stored.managedHomePath, '.orca-managed-kimi-home'), 'utf-8').trim()
    ).toBe(stored.id)
    if (process.platform !== 'win32') {
      expect(statSync(stored.managedHomePath).mode & 0o777).toBe(0o700)
      expect(
        statSync(join(stored.managedHomePath, 'credentials', 'kimi-code.json')).mode & 0o777
      ).toBe(0o600)
    }
  })

  it('keeps the source home unchanged', async () => {
    const root = tempRoot()
    const source = createSourceHome(root)
    const before = readFileSync(join(source, 'credentials', 'kimi-code.json'), 'utf-8')

    await createService(createStore(), root).addAccountFromHome(source, 'Personal')

    expect(readFileSync(join(source, 'credentials', 'kimi-code.json'), 'utf-8')).toBe(before)
    expect(readFileSync(join(source, 'sessions', 'history.jsonl'), 'utf-8')).toBe('private session')
  })

  it.skipIf(process.platform === 'win32')(
    'makes the managed credential scope writable only by its owner',
    async () => {
      const root = tempRoot()
      const source = createSourceHome(root)
      const sourceCredentials = join(source, 'credentials')
      const sourceCredential = join(sourceCredentials, 'kimi-code.json')
      chmodSync(sourceCredentials, 0o500)
      chmodSync(sourceCredential, 0o400)
      const store = createStore()

      await createService(store, root).addAccountFromHome(source, 'Work')

      const managedHome = store.getSettings().kimiManagedAccounts![0].managedHomePath
      expect(statSync(join(managedHome, 'credentials')).mode & 0o777).toBe(0o700)
      expect(statSync(join(managedHome, 'credentials', 'kimi-code.json')).mode & 0o777).toBe(0o600)
      expect(statSync(sourceCredentials).mode & 0o777).toBe(0o500)
      expect(statSync(sourceCredential).mode & 0o777).toBe(0o400)
      chmodSync(sourceCredentials, 0o700)
      chmodSync(sourceCredential, 0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects symbolic links in the imported credential scope',
    async () => {
      const root = tempRoot()
      const source = createSourceHome(root)
      writeFileSync(join(root, 'outside.json'), 'secret')
      symlinkSync(join(root, 'outside.json'), join(source, 'credentials', 'linked.json'))
      const service = createService(createStore(), root)

      await expect(service.addAccountFromHome(source, 'Work')).rejects.toThrow(/symbolic links/i)
    }
  )

  it('selects, renames, and removes only an owned managed home', async () => {
    const root = tempRoot()
    vi.stubEnv('KIMI_CODE_HOME', join(root, 'system-home'))
    const store = createStore()
    const service = createService(store, root)
    const added = await service.addAccountFromHome(createSourceHome(root), 'Work')
    const accountId = added.accounts[0].id
    const managedHome = store.getSettings().kimiManagedAccounts![0].managedHomePath

    expect((await service.selectAccount(null)).activeAccountId).toBeNull()
    expect((await service.selectAccount(accountId)).activeAccountId).toBe(accountId)
    expect((await service.renameAccount(accountId, 'Renamed')).accounts[0].label).toBe('Renamed')
    expect(service.getSelectedManagedHomePath()).toBe(realpathSync(managedHome))
    expect((await service.removeAccount(accountId)).accounts).toEqual([])
    expect(() => statSync(managedHome)).toThrow()
  })

  it('refuses removal after the ownership marker is replaced', async () => {
    const root = tempRoot()
    vi.stubEnv('KIMI_CODE_HOME', join(root, 'system-home'))
    const store = createStore()
    const service = createService(store, root)
    const added = await service.addAccountFromHome(createSourceHome(root), 'Work')
    const stored = store.getSettings().kimiManagedAccounts![0]
    writeFileSync(join(stored.managedHomePath, '.orca-managed-kimi-home'), 'different-account\n')

    await expect(service.removeAccount(added.accounts[0].id)).rejects.toThrow(/marker/i)
    expect(statSync(stored.managedHomePath).isDirectory()).toBe(true)
  })

  it('repairs a removed active account selection without exposing its path', () => {
    const root = tempRoot()
    const service = createService(
      createStore({ kimiManagedAccounts: [], activeKimiManagedAccountId: 'removed' }),
      root
    )

    expect(service.listAccounts()).toEqual({ accounts: [], activeAccountId: null })
    expect(service.getSelectedManagedHomePath()).toBeNull()
  })

  it('returns only valid owned host homes for session discovery', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = createService(store, root)
    await service.addAccountFromHome(createSourceHome(root), 'Work')
    const stored = store.getSettings().kimiManagedAccounts![0]

    expect(service.getManagedHomePathsForSessionDiscovery()).toEqual([
      realpathSync(stored.managedHomePath)
    ])

    writeFileSync(join(stored.managedHomePath, '.orca-managed-kimi-home'), 'wrong-account\n')
    expect(service.getManagedHomePathsForSessionDiscovery()).toEqual([])
  })

  it('rolls back an import when managed hook installation fails', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = new KimiAccountService(store, join(root, 'managed'), () => ({
      state: 'error',
      detail: 'hook write failed'
    }))

    await expect(service.addAccountFromHome(createSourceHome(root), 'Work')).rejects.toThrow(
      'hook write failed'
    )
    expect(store.getSettings().kimiManagedAccounts).toEqual([])
  })

  it('creates and selects a managed account after device-code login succeeds', async () => {
    const root = tempRoot()
    const store = createStore()
    const instructions = vi.fn(async () => 'continue' as const)
    const login = vi.fn(async (homePath: string, onInstructions: KimiLoginInstructionHandler) => {
      mkdirSync(join(homePath, 'credentials'), { recursive: true })
      writeFileSync(join(homePath, 'credentials', 'kimi-code.json'), '{"access_token":"secret"}')
      await onInstructions({
        verificationUrl: 'https://auth.kimi.com/device',
        message: 'Enter code ABCD-EFGH'
      })
    })
    const service = new KimiAccountService(
      store,
      join(root, 'managed'),
      () => ({ state: 'installed', detail: null }),
      login
    )

    const state = await service.addAccountWithLogin('Work', instructions)

    expect(state.accounts).toHaveLength(1)
    expect(state.activeAccountId).toBe(state.accounts[0].id)
    expect(state.accounts[0]).not.toHaveProperty('managedHomePath')
    expect(JSON.stringify(state)).not.toContain('secret')
    const stored = store.getSettings().kimiManagedAccounts![0]
    expect(
      readFileSync(join(stored.managedHomePath, 'credentials', 'kimi-code.json'), 'utf-8')
    ).toContain('secret')
  })

  it('rolls back a login that exits without credentials', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = new KimiAccountService(
      store,
      join(root, 'managed'),
      () => ({ state: 'installed', detail: null }),
      async () => {}
    )

    const failure = await service
      .addAccountWithLogin('Work', async () => 'continue')
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/credential/i)
    expect((failure as Error).message).not.toContain(root)
    expect(store.getSettings().kimiManagedAccounts).toEqual([])
  })

  it.each(['', '   ', 'line\nbreak', 'x'.repeat(121)])(
    'rejects invalid labels %#',
    async (label) => {
      const root = tempRoot()
      const service = createService(createStore(), root)
      await expect(service.addAccountFromHome(createSourceHome(root), label)).rejects.toThrow(
        /label/i
      )
    }
  )
})
