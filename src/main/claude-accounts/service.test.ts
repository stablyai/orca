/* eslint-disable max-lines -- test suite covers Claude capture and rollback edge cases */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-claude-service-test'
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude'
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

// Why: the azure-foundry handler shells to `az` when Entra ID is enabled. Stub
// the detection + token helpers so the service test stays hermetic.
vi.mock('./providers/azure-cli', () => ({
  detectAzureEntraIdSignIn: vi.fn(async () => ({ ok: true, account: { user: 'a', tenantId: 't' } })),
  getEntraAccessTokenForCognitiveServices: vi.fn(async () => ({ ok: true, token: 'jwt' }))
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function createService(): unknown {
  return {}
}

async function readCapturedCredentials(
  configDir: string,
  previousLegacyKeychain: string | null
): Promise<string | null> {
  const { ClaudeAccountService } = await import('./service')
  const service = new ClaudeAccountService(
    createService() as never,
    createService() as never,
    createService() as never
  )
  return (
    service as unknown as {
      readCapturedCredentials(
        configDir: string,
        previousLegacyKeychain: string | null
      ): Promise<string | null>
    }
  ).readCapturedCredentials(configDir, previousLegacyKeychain)
}

describe('ClaudeAccountService credential capture', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('darwin')
    tempDir = null
    vi.mocked(readActiveClaudeKeychainCredentials).mockReset()
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockReset()
    vi.mocked(readManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(deleteActiveClaudeKeychainCredentialsStrict).mockClear()
    vi.mocked(writeActiveClaudeKeychainCredentials).mockReset()
    vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('accepts scoped Keychain capture even when it matches the previous legacy item', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce('same-account')
      .mockResolvedValueOnce('same-account')

    await expect(readCapturedCredentials('/tmp/claude-config', 'same-account')).resolves.toBe(
      'same-account'
    )

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith('/tmp/claude-config')
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
  })

  it('rejects unchanged legacy fallback when scoped capture is missing', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('previous')

    await expect(readCapturedCredentials('/tmp/claude-config', 'previous')).resolves.toBeNull()

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(
      1,
      '/tmp/claude-config'
    )
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2)
  })

  it('accepts changed legacy fallback for old Claude Code builds', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('new-legacy')

    await expect(readCapturedCredentials('/tmp/claude-config', 'previous')).resolves.toBe(
      'new-legacy'
    )

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(
      1,
      '/tmp/claude-config'
    )
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2)
  })

  it('falls back to captured credentials file on macOS', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-capture-'))
    writeFileSync(join(tempDir, '.credentials.json'), '{"token":"file"}\n', 'utf-8')
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('previous')

    await expect(readCapturedCredentials(tempDir, 'previous')).resolves.toBe('{"token":"file"}\n')
  })

  it('fails login capture when legacy Keychain cleanup fails', async () => {
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue('previous-legacy')
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue('captured-scoped')
    vi.mocked(writeActiveClaudeKeychainCredentials).mockRejectedValue(new Error('restore failed'))
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      createService() as never,
      createService() as never,
      createService() as never
    )
    const testService = service as unknown as {
      runClaudeCommand: () => Promise<string>
      runClaudeLoginAndCapture(): Promise<{ credentialsJson: string }>
    }
    testService.runClaudeCommand = vi.fn(async () => '{"account":{"email":"user@example.com"}}')

    await expect(testService.runClaudeLoginAndCapture()).rejects.toThrow('restore failed')
  })

  it('restores previous managed auth when reauth materialization fails', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"old":true}\n', 'utf-8')
    writeFileSync(join(managedAuthPath, 'oauth-account.json'), '{"oldOauth":true}\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'account-1'
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
      syncForCurrentSelection: vi.fn(async () => {
        throw new Error('materialize failed')
      })
    }
    const rateLimits = { evictInactiveClaudeCache: vi.fn(), refreshForClaudeAccountChange: vi.fn() }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow('materialize failed')

    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe('{"old":true}\n')
    expect(readFileSync(join(managedAuthPath, 'oauth-account.json'), 'utf-8')).toBe(
      '{"oldOauth":true}\n'
    )
    expect(store.getSettings().claudeManagedAccounts[0].email).toBe('old@example.com')
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalled()
  })

  it('restores settings without rematerializing when managed-auth rollback write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, 'oauth-account.json'), '{"oldOauth":true}\n', 'utf-8')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue('{"old":true}\n')
    vi.mocked(writeManagedClaudeKeychainCredentials)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('managed restore failed'))
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'account-1'
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
      syncForCurrentSelection: vi.fn(async () => {
        throw new Error('materialize failed')
      })
    }
    const rateLimits = { evictInactiveClaudeCache: vi.fn(), refreshForClaudeAccountChange: vi.fn() }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow('materialize failed')

    expect(store.getSettings().claudeManagedAccounts[0].email).toBe('new@example.com')
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[claude-accounts] Failed to restore managed credentials during rollback:',
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('restores oauth metadata when new credential write and credential rollback fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, 'oauth-account.json'), '{"oldOauth":true}\n', 'utf-8')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue('{"old":true}\n')
    vi.mocked(writeManagedClaudeKeychainCredentials)
      .mockRejectedValueOnce(new Error('new credentials failed'))
      .mockRejectedValueOnce(new Error('credential rollback failed'))
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'account-1'
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
      syncForCurrentSelection: vi.fn()
    }
    const rateLimits = { evictInactiveClaudeCache: vi.fn(), refreshForClaudeAccountChange: vi.fn() }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'new credentials failed'
    )

    expect(readFileSync(join(managedAuthPath, 'oauth-account.json'), 'utf-8')).toBe(
      '{"oldOauth":true}\n'
    )
    expect(store.getSettings().claudeManagedAccounts[0].email).toBe('old@example.com')
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[claude-accounts] Failed to restore managed credentials during rollback:',
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('restores old metadata when rollback restores credentials but oauth restore fails', async () => {
    setPlatform('linux')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const oauthPath = join(managedAuthPath, 'oauth-account.json')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"old":true}\n', 'utf-8')
    writeFileSync(oauthPath, '{"oldOauth":true}\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'account-1'
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
      syncForCurrentSelection: vi.fn(async () => {
        rmSync(oauthPath, { force: true })
        mkdirSync(oauthPath)
        throw new Error('materialize failed')
      })
    }
    const rateLimits = { evictInactiveClaudeCache: vi.fn(), refreshForClaudeAccountChange: vi.fn() }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow('materialize failed')

    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe('{"old":true}\n')
    expect(store.getSettings().claudeManagedAccounts[0].email).toBe('old@example.com')
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refreshes rate limits without recaching a removed active account', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"old":true}\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'account-1'
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      syncForCurrentSelection: vi.fn(async () => {}),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )

    await service.removeAccount('account-1')

    expect(rateLimits.evictInactiveClaudeCache).toHaveBeenCalledWith('account-1')
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith()
    expect(settings).toMatchObject({
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null
    })
  })

  it('evicts inactive rate-limit cache after successful reauth', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const managedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"old":true}\n', 'utf-8')
    writeFileSync(join(managedAuthPath, 'oauth-account.json'), '{"oldOauth":true}\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedAuthPath,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: null
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      syncForCurrentSelection: vi.fn(async () => {}),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await service.reauthenticateAccount('account-1')

    expect(rateLimits.evictInactiveClaudeCache).toHaveBeenCalledWith('account-1')
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith()
    expect(settings.claudeManagedAccounts[0].email).toBe('new@example.com')
  })
})

describe('ClaudeAccountService addAccount polymorphic input', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('linux')
    tempDir = null
    vi.mocked(readManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  type PolymorphicSettings = {
    claudeManagedAccounts: unknown[]
    activeClaudeManagedAccountId: string | null
  }

  async function buildPolymorphicService(): Promise<{
    service: import('./service').ClaudeAccountService
    getSettings: () => PolymorphicSettings
    runtimeAuth: {
      clearLastWrittenCredentialsJson: ReturnType<typeof vi.fn>
      forceMaterializeCurrentSelectionForRollback: ReturnType<typeof vi.fn>
      syncForCurrentSelection: ReturnType<typeof vi.fn>
    }
    rateLimits: {
      evictInactiveClaudeCache: ReturnType<typeof vi.fn>
      refreshForClaudeAccountChange: ReturnType<typeof vi.fn>
    }
  }> {
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    let settings: PolymorphicSettings = {
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null
    }
    const store = {
      getSettings: vi.fn((): PolymorphicSettings => settings),
      updateSettings: vi.fn((updates: Partial<PolymorphicSettings>): PolymorphicSettings => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      syncForCurrentSelection: vi.fn(async () => {}),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({
        accounts: [],
        activeAccountId: null
      }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    return { service, getSettings: () => settings, runtimeAuth, rateLimits }
  }

  it('dispatches to anthropic-api-key handler when input has that authMethod', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'My API key',
      secretFromUser: 'sk-ant-test-key'
    })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.authMethod).toBe('anthropic-api-key')
    expect(result.activeAccountId).toBe(result.accounts[0]?.id)
    expect(writeManagedClaudeKeychainCredentials).toHaveBeenCalledWith(
      result.accounts[0]?.id,
      'sk-ant-test-key'
    )
  })

  it('dispatches to anthropic-compat handler for zai preset and sets baseUrl from preset', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'anthropic-compat',
      label: 'z.ai',
      secretFromUser: 'zai-token',
      providerConfig: { preset: 'zai' }
    })
    const compat = result.accounts[0]
    expect(compat?.credentials).toEqual({
      authMethod: 'anthropic-compat',
      baseUrl: 'https://api.z.ai/api/anthropic',
      preset: 'zai'
    })
  })

  it('rolls back settings on handler error when compat preset is missing', async () => {
    const { service, getSettings } = await buildPolymorphicService()
    await expect(
      service.addAccount({
        authMethod: 'anthropic-compat',
        label: 'Bad',
        secretFromUser: 'token',
        providerConfig: {} as never
      })
    ).rejects.toThrow(/preset/i)
    expect(getSettings().claudeManagedAccounts).toHaveLength(0)
    expect(service.listAccounts().accounts).toHaveLength(0)
  })

  it('addAccount(input) for azure-foundry API-key path persists credentials and active id', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'Foundry prod',
      secretFromUser: 'fkey-abc',
      providerConfig: { resource: 'prod-resource' }
    })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.authMethod).toBe('azure-foundry')
    expect(result.accounts[0]?.credentials).toEqual({
      authMethod: 'azure-foundry',
      resource: 'prod-resource',
      useEntraId: false
    })
    expect(result.activeAccountId).toBe(result.accounts[0]?.id)
  })

  it('addAccount(input) for azure-foundry Entra ID path persists useEntraId true and skips secret', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'azure-foundry',
      label: 'Foundry dev',
      providerConfig: { resource: 'dev-resource', useEntraId: true }
    })
    expect(result.accounts[0]?.credentials).toEqual({
      authMethod: 'azure-foundry',
      resource: 'dev-resource',
      useEntraId: true
    })
  })

  it('routes aws-bedrock input to the Bedrock handler', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'aws-bedrock',
      label: 'Bedrock US',
      secretFromUser: 'bearer-xyz',
      providerConfig: { region: 'us-east-1' }
    })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.authMethod).toBe('aws-bedrock')
    expect(result.accounts[0]?.credentials).toMatchObject({
      authMethod: 'aws-bedrock',
      region: 'us-east-1',
      inferenceProfilePrefix: 'us.'
    })
  })

  it('routes google-vertex input to the Vertex handler', async () => {
    const { service } = await buildPolymorphicService()
    const result = await service.addAccount({
      authMethod: 'google-vertex',
      label: 'Vertex',
      providerConfig: { projectId: 'p', region: 'us-east5' }
    })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.authMethod).toBe('google-vertex')
    expect(result.accounts[0]?.credentials).toMatchObject({
      authMethod: 'google-vertex',
      projectId: 'p',
      region: 'us-east5'
    })
  })

  it('no-arg addAccount() still routes through the existing OAuth flow', async () => {
    const { service } = await buildPolymorphicService()
    ;(
      service as unknown as {
        runClaudeLoginAndCapture(): Promise<{
          credentialsJson: string
          oauthAccount: unknown
          identity: { email: string; organizationUuid: null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"oauth":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'oauth@example.com', organizationUuid: null, organizationName: null }
    }))

    const result = await service.addAccount()

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.authMethod).toBe('subscription-oauth')
    expect(result.accounts[0]?.email).toBe('oauth@example.com')
  })
})

// Why: P2 T19 — workspace override + validate-input probe. The override is a
// pointer-only edit on the persistence settings; validateInput materializes a
// candidate via the provider handler without persisting anything.
describe('ClaudeAccountService workspace override + validateInput (P2)', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('linux')
    tempDir = null
    vi.mocked(readManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  type OverrideSettings = {
    claudeManagedAccounts: unknown[]
    activeClaudeManagedAccountId: string | null
    claudeAccountIdByWorkspace?: Record<string, string>
  }

  async function buildOverrideService(): Promise<{
    service: import('./service').ClaudeAccountService
    getSettings: () => OverrideSettings
  }> {
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    let settings: OverrideSettings = {
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null
    }
    const store = {
      getSettings: vi.fn((): OverrideSettings => settings),
      updateSettings: vi.fn((updates: Partial<OverrideSettings>): OverrideSettings => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      syncForCurrentSelection: vi.fn(async () => {}),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => ({
        accounts: [],
        activeAccountId: null
      }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )
    return { service, getSettings: () => settings }
  }

  it('setWorkspaceOverride writes the entry to settings', async () => {
    const { service, getSettings } = await buildOverrideService()
    await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'A',
      secretFromUser: 'k'
    })
    const [account] = service.listAccounts().accounts
    await service.setWorkspaceOverride({ worktreeId: 'r::/wt1', accountId: account.id })
    expect(getSettings().claudeAccountIdByWorkspace?.['r::/wt1']).toBe(account.id)
  })

  it('clearWorkspaceOverride removes the entry', async () => {
    const { service, getSettings } = await buildOverrideService()
    await service.addAccount({
      authMethod: 'anthropic-api-key',
      label: 'A',
      secretFromUser: 'k'
    })
    const [account] = service.listAccounts().accounts
    await service.setWorkspaceOverride({ worktreeId: 'r::/wt1', accountId: account.id })
    await service.clearWorkspaceOverride({ worktreeId: 'r::/wt1' })
    expect(getSettings().claudeAccountIdByWorkspace?.['r::/wt1']).toBeUndefined()
  })

  it('setWorkspaceOverride rejects unknown accountId', async () => {
    const { service } = await buildOverrideService()
    await expect(
      service.setWorkspaceOverride({ worktreeId: 'r::/wt1', accountId: 'does-not-exist' })
    ).rejects.toThrow(/unknown account/i)
  })

  it('validateInput materializes a candidate via the provider handler without persisting', async () => {
    const { service, getSettings } = await buildOverrideService()
    const result = await service.validateInput({
      authMethod: 'anthropic-api-key',
      label: 'probe',
      secretFromUser: 'sk-ant-probe'
    })
    // Anthropic API key handler validate() probes /v1/models — in tests fetch is
    // unmocked here, so the probe fails. The point is the call resolves to a
    // ValidationResult shape without throwing, and no account was persisted.
    expect(typeof result.ok).toBe('boolean')
    expect(getSettings().claudeManagedAccounts).toHaveLength(0)
  })
})
