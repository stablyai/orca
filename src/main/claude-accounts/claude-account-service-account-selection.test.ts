import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-selection-test')

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

  it('refreshes rate limits without recaching a removed active account', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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

  it('switches the active Claude account while PTYs are live', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
})
