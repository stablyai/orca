import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService.addAccountFromHome', () => {
  registerCodexAccountsTestHomes()

  it('registers a managed Codex account by importing an authenticated CODEX_HOME', async () => {
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const sourceHome = mkdtempSync(join(tmpdir(), 'orca-codex-source-'))
    writeFileSync(
      join(sourceHome, 'auth.json'),
      createCodexAuthJson('new@example.com', 'provider-account-1', 'refresh-token'),
      'utf-8'
    )

    try {
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

      const result = await service.addAccountFromHome(sourceHome)

      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]?.email).toBe('new@example.com')
      const managedHomePath = store.getSettings().codexManagedAccounts[0].managedHomePath
      expect(existsSync(join(managedHomePath, 'auth.json'))).toBe(true)
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    } finally {
      rmSync(sourceHome, { recursive: true, force: true })
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('restores settings and runtime selection when post-write activation fails', async () => {
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const sourceHome = mkdtempSync(join(tmpdir(), 'orca-codex-source-rollback-'))
    writeFileSync(
      join(sourceHome, 'auth.json'),
      createCodexAuthJson('new@example.com', 'provider-account-1', 'refresh-token'),
      'utf-8'
    )

    try {
      const settings = createSettings()
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      let managedHomePath: string | null = null
      runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
        managedHomePath = store.getSettings().codexManagedAccounts[0]?.managedHomePath ?? null
        throw new Error('activation failed')
      })
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await expect(service.addAccountFromHome(sourceHome)).rejects.toThrow('activation failed')

      expect(store.getSettings().codexManagedAccounts).toHaveLength(0)
      expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(2)
      expect(managedHomePath).not.toBeNull()
      expect(existsSync(managedHomePath!)).toBe(false)
    } finally {
      rmSync(sourceHome, { recursive: true, force: true })
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('rejects when the source home has no auth.json', async () => {
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const sourceHome = mkdtempSync(join(tmpdir(), 'orca-codex-source-empty-'))

    try {
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

      await expect(service.addAccountFromHome(sourceHome)).rejects.toThrow(
        /No Codex credentials found/
      )
      expect(store.getSettings().codexManagedAccounts).toHaveLength(0)
    } finally {
      rmSync(sourceHome, { recursive: true, force: true })
      vi.doUnmock('../codex-cli/command')
    }
  })
})
