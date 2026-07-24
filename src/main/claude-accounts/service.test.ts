/* eslint-disable max-lines -- test suite covers Claude capture and rollback edge cases */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ClaudeManagedAccount } from '../../shared/types'
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
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith('account-1', {
      runtime: 'host'
    })
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
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith(undefined, {
      runtime: 'host'
    })
    expect(settings.claudeManagedAccounts[0].email).toBe('new@example.com')
  })

  it('adds an account without switching the active Claude auth while PTYs are live', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const hostAuthPath = join(tempDir, 'claude-accounts', 'host-account', 'auth')
    mkdirSync(hostAuthPath, { recursive: true })
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'host-account',
          email: 'host@example.com',
          managedAuthPath: hostAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: { host: 'host-account', wsl: { Ubuntu: null } }
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
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
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

    markClaudePtySpawned('live-claude-pty')
    try {
      await service.addAccount({ runtime: 'host' })
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expect(settings.claudeManagedAccounts).toHaveLength(2)
    expect(settings.claudeManagedAccounts[1].email).toBe('new@example.com')
    expect(settings.activeClaudeManagedAccountId).toBe('host-account')
    expect(settings.activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: null }
    })
    expect(runtimeAuth.syncForCurrentSelection).not.toHaveBeenCalled()
    expect(rateLimits.refreshForClaudeAccountChange).not.toHaveBeenCalled()
    expect(rateLimits.evictInactiveClaudeCache).toHaveBeenCalledWith(
      settings.claudeManagedAccounts[1].id
    )
  })

  it('rejects adding a Claude account whose identity already exists', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const existingAuthPath = join(tempDir, 'claude-accounts', 'existing-account', 'auth')
    mkdirSync(existingAuthPath, { recursive: true })
    const existingMarkerPath = join(existingAuthPath, '.orca-managed-claude-auth')
    writeFileSync(existingMarkerPath, 'existing-account\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'existing-account',
          email: 'new@example.com',
          managedAuthPath: existingAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'existing-account',
      activeClaudeManagedAccountIdsByRuntime: { host: 'existing-account', wsl: {} }
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
          identity: { email: string; organizationUuid: string | null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))

    await expect(service.addAccount({ runtime: 'host' })).rejects.toThrow(
      'This Claude account is already added.'
    )

    expect(settings.claudeManagedAccounts).toHaveLength(1)
    expect(readFileSync(existingMarkerPath, 'utf-8')).toBe('existing-account\n')
    // The guard fires before credentials/settings change, so rollback I/O
    // would only add latency and could mask the duplicate error.
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).not.toHaveBeenCalled()
    // The rejected add's throwaway managed-auth dir must be cleaned up, leaving
    // only the pre-existing account's dir behind.
    expect(readdirSync(join(tempDir, 'claude-accounts')).sort()).toEqual(['existing-account'])
  })

  it('adds a Claude account with the same email under a different organization', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const existingAuthPath = join(tempDir, 'claude-accounts', 'existing-account', 'auth')
    mkdirSync(existingAuthPath, { recursive: true })
    writeFileSync(
      join(existingAuthPath, '.orca-managed-claude-auth'),
      'existing-account\n',
      'utf-8'
    )
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'existing-account',
          email: 'new@example.com',
          managedAuthPath: existingAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: 'org-A',
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'existing-account',
      activeClaudeManagedAccountIdsByRuntime: { host: 'existing-account', wsl: {} }
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
          identity: { email: string; organizationUuid: string | null; organizationName: null }
        }>
      }
    ).runClaudeLoginAndCapture = vi.fn(async () => ({
      credentialsJson: '{"new":true}\n',
      oauthAccount: { newOauth: true },
      identity: { email: 'new@example.com', organizationUuid: 'org-B', organizationName: null }
    }))

    await service.addAccount({ runtime: 'host' })

    expect(settings.claudeManagedAccounts).toHaveLength(2)
    expect(settings.claudeManagedAccounts[1].email).toBe('new@example.com')
    expect(settings.claudeManagedAccounts[1].organizationUuid).toBe('org-B')
  })

  it('switches the active Claude account while PTYs are live', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const firstAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const secondAuthPath = join(tempDir, 'claude-accounts', 'account-2', 'auth')
    mkdirSync(firstAuthPath, { recursive: true })
    mkdirSync(secondAuthPath, { recursive: true })
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'first@example.com',
          managedAuthPath: firstAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'second@example.com',
          managedAuthPath: secondAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeClaudeManagedAccountId: 'account-1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
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
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )

    markClaudePtySpawned('live-claude-pty')
    try {
      await service.selectAccount('account-2')
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expect(settings.activeClaudeManagedAccountId).toBe('account-2')
    expect(settings.activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: 'account-2',
      wsl: {}
    })
    expect(runtimeAuth.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith('account-1', {
      runtime: 'host'
    })
  })

  it('restores the previous selection when a Claude account switch fails', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const firstAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const secondAuthPath = join(tempDir, 'claude-accounts', 'account-2', 'auth')
    mkdirSync(firstAuthPath, { recursive: true })
    mkdirSync(secondAuthPath, { recursive: true })
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'account-1',
          email: 'first@example.com',
          managedAuthPath: firstAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'second@example.com',
          managedAuthPath: secondAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeClaudeManagedAccountId: 'account-1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const runtimeAuth = {
      syncForCurrentSelection: vi.fn(async () => {
        throw new Error('runtime sync failed')
      }),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )

    await expect(service.selectAccount('account-2')).rejects.toThrow('runtime sync failed')

    expect(settings.activeClaudeManagedAccountId).toBe('account-1')
    expect(settings.activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: 'account-1',
      wsl: {}
    })
    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalled()
    expect(rateLimits.refreshForClaudeAccountChange).not.toHaveBeenCalled()
  })

  it('selects a WSL account without changing the Windows active account', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const hostAuthPath = join(tempDir, 'claude-accounts', 'host-account', 'auth')
    const wslAuthPath = join(tempDir, 'claude-accounts', 'wsl-account', 'auth')
    mkdirSync(hostAuthPath, { recursive: true })
    mkdirSync(wslAuthPath, { recursive: true })
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'host-account',
          email: 'host@example.com',
          managedAuthPath: hostAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedAuthPath: wslAuthPath,
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/jin/.local/share/orca/claude-accounts/wsl-account/auth',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: { host: 'host-account', wsl: { Ubuntu: null } }
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
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )

    const snapshot = await service.selectAccountForTarget('wsl-account', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(settings.activeClaudeManagedAccountId).toBe('host-account')
    expect(settings.activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(snapshot.activeAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(runtimeAuth.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith(null, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('rejects selecting a WSL account for the Windows target', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const wslAuthPath = join(tempDir, 'claude-accounts', 'wsl-account', 'auth')
    mkdirSync(wslAuthPath, { recursive: true })
    const settings = {
      claudeManagedAccounts: [
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedAuthPath: wslAuthPath,
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/jin/.local/share/orca/claude-accounts/wsl-account/auth',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn()
    }
    const runtimeAuth = {
      syncForCurrentSelection: vi.fn(async () => {}),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    const rateLimits = {
      refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
    }
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      store as never,
      rateLimits as never,
      runtimeAuth as never
    )

    await expect(
      service.selectAccountForTarget('wsl-account', { runtime: 'host' })
    ).rejects.toThrow('different runtime')
    expect(runtimeAuth.syncForCurrentSelection).not.toHaveBeenCalled()
    expect(rateLimits.refreshForClaudeAccountChange).not.toHaveBeenCalled()
  })

  it('removes a WSL account without clearing the Windows active account', async () => {
    setPlatform('linux')
    tempDir = '/tmp/orca-claude-service-test'
    rmSync(tempDir, { recursive: true, force: true })
    const hostAuthPath = join(tempDir, 'claude-accounts', 'host-account', 'auth')
    const wslAuthPath = join(tempDir, 'claude-accounts', 'wsl-account', 'auth')
    mkdirSync(hostAuthPath, { recursive: true })
    mkdirSync(wslAuthPath, { recursive: true })
    writeFileSync(join(wslAuthPath, '.orca-managed-claude-auth'), 'wsl-account\n', 'utf-8')
    let settings = {
      claudeManagedAccounts: [
        {
          id: 'host-account',
          email: 'host@example.com',
          managedAuthPath: hostAuthPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedAuthPath: wslAuthPath,
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/jin/.local/share/orca/claude-accounts/wsl-account/auth',
          authMethod: 'subscription-oauth',
          organizationUuid: null,
          organizationName: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account' }
      }
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

    await service.removeAccount('wsl-account')

    expect(settings.activeClaudeManagedAccountId).toBe('host-account')
    expect(settings.activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: null }
    })
    expect(rateLimits.evictInactiveClaudeCache).toHaveBeenCalledWith('wsl-account')
    expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith('wsl-account', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('removes command listeners when Claude sign-in times out', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['login'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        { keepStdinOpen: true }
      )
      const rejection = expect(commandPromise).rejects.toThrow(
        'Claude sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(1000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
    }
  })

  it('owns the complete cmd.exe command line for a resolved Windows Claude command', async () => {
    setPlatform('win32')
    vi.resetModules()
    commandMocks.resolveClaudeCommand.mockReturnValueOnce(
      'C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd'
    )
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => {
      child.stdout.write('{"email":"user@example.com"}\n')
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      await (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'status', '--json'],
        { windowsPath: 'C:\\tmp\\claude-auth', linuxPath: null, wslDistro: null },
        1000
      )

      expect(spawnMock).toHaveBeenCalledWith(
        process.env.ComSpec ?? 'cmd.exe',
        [
          '/d',
          '/v:off',
          '/s',
          '/c',
          '""C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json""'
        ],
        expect.objectContaining({ shell: false, windowsVerbatimArguments: true })
      )
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('keeps WSL execution separate from Windows command resolution', async () => {
    setPlatform('win32')
    vi.resetModules()
    commandMocks.resolveClaudeCommand.mockClear()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => {
      child.stdout.write('{"email":"user@example.com"}\n')
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      await (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'status', '--json'],
        {
          windowsPath: 'C:\\tmp\\claude-auth',
          linuxPath: '/home/user/.config/orca auth',
          wslDistro: 'Ubuntu Test'
        },
        1000
      )

      expect(commandMocks.resolveClaudeCommand).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        [
          '-d',
          'Ubuntu Test',
          '--',
          'bash',
          '-lc',
          "export CLAUDE_CONFIG_DIR='/home/user/.config/orca auth'; exec claude 'auth' 'status' '--json'"
        ],
        expect.objectContaining({ shell: false, windowsVerbatimArguments: false })
      )
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('pipes stdin only for the explicit Claude account login command', async () => {
    setPlatform('linux')
    vi.resetModules()
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    const loginChild = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    loginChild.stdin = new PassThrough()
    loginChild.stdout = new PassThrough()
    loginChild.stderr = new PassThrough()
    loginChild.kill = vi.fn()
    const statusChild = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    statusChild.stdout = new PassThrough()
    statusChild.stderr = new PassThrough()
    statusChild.kill = vi.fn()
    const spawnMock = vi.fn(
      (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[1] === 'login') {
          writeFileSync(
            join(options.env.CLAUDE_CONFIG_DIR!, '.credentials.json'),
            '{"claudeAiOauth":{"email":"user@example.com","accessToken":"token"}}\n',
            'utf-8'
          )
          queueMicrotask(() => loginChild.emit('close', 0))
          return loginChild
        }
        statusChild.stdout.write('{"email":"user@example.com"}\n')
        queueMicrotask(() => statusChild.emit('close', 0))
        return statusChild
      }
    )
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [] as ClaudeManagedAccount[],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
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
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      await service.addAccount()

      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        'claude',
        ['auth', 'login', '--claudeai'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      )
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        'claude',
        ['auth', 'status', '--json'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
      )
      expect(settings.claudeManagedAccounts[0]?.email).toBe('user@example.com')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('rejects immediately when Claude sign-in is denied', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4242
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    // Denial must tear down the whole detached login/browser tree (process-group kill on POSIX),
    // not just the direct child — otherwise the orphaned auth processes the `detached` spawn guards against leak.
    const killTree = vi.spyOn(process, 'kill').mockReturnValue(true)

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['login'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        180_000,
        { keepStdinOpen: true }
      )

      child.stderr.write('OAuth authorization failed: access_denied\n')

      await expect(commandPromise).rejects.toThrow('Claude sign-in was denied. Please try again.')
      expect(killTree).toHaveBeenCalledWith(-child.pid)
      expect(child.kill).not.toHaveBeenCalled()
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      killTree.mockRestore()
      vi.doUnmock('node:child_process')
    }
  })

  it('cancels an in-flight Claude account add', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
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
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1)
      })

      expect(service.cancelPendingLogin()).toBe(true)
      await expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(service.cancelPendingLogin()).toBe(false)
      expect(settings.claudeManagedAccounts).toEqual([])
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('honors cancel before Claude login command starts', async () => {
    setPlatform('linux')
    vi.resetModules()
    let releaseKeychainRead: (value: string | null) => void = () => {}
    vi.mocked(readActiveClaudeKeychainCredentials).mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseKeychainRead = resolve
      })
    )
    const spawnMock = vi.fn()
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
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
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(readActiveClaudeKeychainCredentials).toHaveBeenCalled()
      })

      expect(service.cancelPendingLogin()).toBe(true)
      expect(service.cancelPendingLogin()).toBe(false)
      expect(spawnMock).not.toHaveBeenCalled()
      releaseKeychainRead(null)
      await expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(spawnMock).not.toHaveBeenCalled()
      expect(service.cancelPendingLogin()).toBe(false)
      expect(settings.claudeManagedAccounts).toEqual([])
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('uses taskkill to cancel the Windows Claude login process tree', async () => {
    setPlatform('win32')
    vi.resetModules()
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.pid = 1234
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const taskkill = new EventEmitter()
    const spawnMock = vi.fn((command: string) => (command === 'taskkill.exe' ? taskkill : child))
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      let settings = {
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
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
        forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
      }
      const rateLimits = {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn()
      }
      const service = new ClaudeAccountService(
        store as never,
        rateLimits as never,
        runtimeAuth as never
      )

      const addPromise = service.addAccount()
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledWith(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/v:off', '/s', '/c', '""claude" "auth" "login" "--claudeai""'],
          expect.objectContaining({ shell: false, windowsVerbatimArguments: true })
        )
      })

      expect(service.cancelPendingLogin()).toBe(true)
      const rejection = expect(addPromise).rejects.toThrow('Claude sign-in was cancelled.')
      expect(child.kill).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(destroyStdin).not.toHaveBeenCalled()
      taskkill.emit('close', 0)
      await rejection
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(service.cancelPendingLogin()).toBe(false)
    } finally {
      vi.doUnmock('node:child_process')
    }
  })
})
