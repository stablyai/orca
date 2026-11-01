import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService.importAccountFromExistingHome', () => {
  registerCodexAccountsTestHomes()

  it('imports an existing CODEX_HOME without running codex login', async () => {
    vi.resetModules()
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'imported-account-id' }))
    const spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))

    try {
      const sourceHome = join(testState.fakeHomeDir, '.codex-work')
      mkdirSync(sourceHome, { recursive: true })
      writeFileSync(
        join(sourceHome, 'auth.json'),
        createCodexAuthJson('imported@example.com', 'provider-imported', 'refresh-imported'),
        'utf-8'
      )
      writeFileSync(join(sourceHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n', 'utf-8')
      writeFileSync(join(sourceHome, 'extra-marker.txt'), 'keep-me\n', 'utf-8')

      const settings = createSettings()
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const snapshot = await service.importAccountFromExistingHome(sourceHome)

      expect(spawnMock).not.toHaveBeenCalled()
      expect(snapshot.accounts).toHaveLength(1)
      expect(snapshot.accounts[0]?.email).toBe('imported@example.com')
      expect(snapshot.activeAccountId).toBe('imported-account-id')

      const managedHomePath = join(
        testState.userDataDir,
        'codex-accounts',
        'imported-account-id',
        'home'
      )
      expect(readFileSync(join(managedHomePath, '.orca-managed-home'), 'utf-8')).toBe(
        'imported-account-id\n'
      )
      expect(readFileSync(join(managedHomePath, 'extra-marker.txt'), 'utf-8')).toBe('keep-me\n')
      expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toContain(
        'provider-imported'
      )
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
      expect(existsSync(join(sourceHome, 'auth.json'))).toBe(true)
    } finally {
      vi.doUnmock('node:crypto')
      vi.doUnmock('node:child_process')
    }
  })

  it('rejects an imported OAuth home that pins a custom provider without canonical config', async () => {
    vi.resetModules()
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'should-not-create' }))
    const spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))

    try {
      const sourceHome = join(testState.fakeHomeDir, '.codex-custom-provider')
      const sourceConfig = [
        'model_provider = "codex-lb"',
        '',
        '[model_providers.codex-lb]',
        'base_url = "https://codex-lb.example.test/v1"',
        'env_key = "CODEX_LB_API_KEY"',
        ''
      ].join('\n')
      mkdirSync(sourceHome, { recursive: true })
      writeFileSync(
        join(sourceHome, 'auth.json'),
        createCodexAuthJson('imported@example.com', 'provider-imported', 'refresh-imported'),
        'utf-8'
      )
      writeFileSync(join(sourceHome, 'config.toml'), sourceConfig, 'utf-8')

      const store = createStore(createSettings())
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.importAccountFromExistingHome(sourceHome)).rejects.toThrow(
        'Orca cannot add a Codex OAuth account while the active Codex config pins the custom provider "codex-lb".'
      )

      expect(spawnMock).not.toHaveBeenCalled()
      expect(store.updateSettings).not.toHaveBeenCalled()
      expect(existsSync(join(testState.userDataDir, 'codex-accounts', 'should-not-create'))).toBe(
        false
      )
      expect(readFileSync(join(sourceHome, 'config.toml'), 'utf-8')).toBe(sourceConfig)
    } finally {
      vi.doUnmock('node:crypto')
      vi.doUnmock('node:child_process')
    }
  })

  it('rejects import when the selected home has no resolvable OAuth email', async () => {
    vi.resetModules()
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'should-not-create' }))
    const spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))

    try {
      const sourceHome = join(testState.fakeHomeDir, '.codex-api-key-only')
      mkdirSync(sourceHome, { recursive: true })
      writeFileSync(
        join(sourceHome, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: 'sk-test' }),
        'utf-8'
      )

      const store = createStore(createSettings())
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.importAccountFromExistingHome(sourceHome)).rejects.toThrow(
        /Could not resolve an account email/
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(existsSync(join(testState.userDataDir, 'codex-accounts', 'should-not-create'))).toBe(
        false
      )
    } finally {
      vi.doUnmock('node:crypto')
      vi.doUnmock('node:child_process')
    }
  })

  it('rejects importing into a WSL account slot', async () => {
    vi.resetModules()
    const store = createStore(createSettings())
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    await expect(
      service.importAccountFromExistingHome('/tmp/does-not-matter', {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ).rejects.toThrow(/WSL account slot is not supported/)
  })
})
