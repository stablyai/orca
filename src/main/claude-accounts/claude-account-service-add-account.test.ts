import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-add-test')

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

  it('adds an account without switching the active Claude auth while PTYs are live', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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

  it('reports the original add failure and still removes managed auth when rollback rematerialization fails', async () => {
    // Why: this is the desktop add path. Previously the rollback's rematerialize
    // was unguarded, so when it threw it replaced the real add error and skipped
    // safeRemoveManagedAuth, leaking the throwaway auth dir.
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
    rmSync(tempDir, { recursive: true, force: true })
    const hostAuthPath = join(tempDir, 'claude-accounts', 'host-account', 'auth')
    mkdirSync(hostAuthPath, { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {
        throw new Error('rematerialize failed')
      })
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
      oauthAccount: null,
      identity: { email: 'new@example.com', organizationUuid: null, organizationName: null }
    }))
    ;(service as unknown as { writeManagedAuth(): Promise<void> }).writeManagedAuth = vi.fn(
      async () => {
        throw new Error('managed auth write failed')
      }
    )

    await expect(service.addAccount({ runtime: 'host' })).rejects.toThrow(
      'managed auth write failed'
    )

    expect(runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalled()
    expect(settings.claudeManagedAccounts).toHaveLength(1)
    // Why: the throwaway account directory must be gone even though rollback threw.
    expect(readdirSync(join(tempDir, 'claude-accounts'))).toEqual(['host-account'])
    warn.mockRestore()
  })

  it('rejects adding a Claude account whose identity already exists', async () => {
    setPlatform('linux')
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
    tempDir = CLAUDE_SERVICE_TEST_ROOT
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
})
