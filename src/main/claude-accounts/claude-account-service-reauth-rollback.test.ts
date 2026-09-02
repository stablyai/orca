import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import {
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-reauth-test')

vi.mock('electron', () => ({
  app: {
    getPath: () => CLAUDE_SERVICE_TEST_ROOT
  }
}))

const commandMocks = vi.hoisted(() => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: commandMocks.resolveClaudeCommand
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

describe('ClaudeAccountService credential capture', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('darwin')
    tempDir = null
    resetClaudeKeychainMocks()
  })

  afterEach(() => {
    restorePlatform()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('restores previous managed auth when reauth materialization fails', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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

  it('evicts inactive rate-limit cache after successful reauth', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith(undefined, {
      runtime: 'host'
    })
    expect(settings.claudeManagedAccounts[0].email).toBe('new@example.com')
  })
})
