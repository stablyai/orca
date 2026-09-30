import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('imports and switches personal and enterprise accounts sharing an email independently', async () => {
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const sourceHomes = [
      mkdtempSync(join(tmpdir(), 'orca-codex-personal-')),
      mkdtempSync(join(tmpdir(), 'orca-codex-enterprise-'))
    ]
    const email = 'same@example.com'
    const credentials = ['plus', 'enterprise'].map((plan) => {
      const parsed = JSON.parse(createCodexAuthJson(email, `provider-${plan}`, `refresh-${plan}`))
      const payload = Buffer.from(
        JSON.stringify({
          email,
          'https://api.openai.com/auth': {
            chatgpt_account_id: `provider-${plan}`,
            chatgpt_plan_type: plan
          }
        })
      ).toString('base64url')
      parsed.tokens.id_token = `header.${payload}.signature`
      return JSON.stringify(parsed)
    })

    try {
      sourceHomes.forEach((home, index) => {
        writeFileSync(join(home, 'auth.json'), credentials[index], 'utf-8')
      })
      const store = createStore(createSettings())
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        runtimeHome as never
      )

      await service.addAccountFromHome(sourceHomes[0])
      const result = await service.addAccountFromHome(sourceHomes[1])
      const accounts = store.getSettings().codexManagedAccounts
      expect(result.accounts).toHaveLength(2)
      expect(new Set(accounts.map((account) => account.id)).size).toBe(2)
      expect(new Set(accounts.map((account) => account.managedHomePath)).size).toBe(2)
      expect(accounts.map((account) => account.email)).toEqual([email, email])
      expect(accounts.map((account) => account.workspaceLabel)).toEqual([
        'Personal (Plus)',
        'Enterprise'
      ])
      expect(accounts.map((account) => account.providerAccountId)).toEqual([
        'provider-plus',
        'provider-enterprise'
      ])

      for (const account of accounts) {
        const selected = await service.selectAccount(account.id)
        expect(selected.activeAccountId).toBe(account.id)
        expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe(account.id)
        accounts.forEach((entry, index) => {
          expect(readFileSync(join(entry.managedHomePath, 'auth.json'), 'utf-8')).toBe(
            credentials[index]
          )
        })
      }
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(4)
    } finally {
      sourceHomes.forEach((home) => rmSync(home, { recursive: true, force: true }))
      vi.doUnmock('../codex-cli/command')
    }
  })

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
