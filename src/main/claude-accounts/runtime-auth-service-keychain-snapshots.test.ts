import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  expectedRuntimeConfigDir,
  readManagedCredentialsForTest,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => createKeychainMock())

describe('ClaudeRuntimeAuthService', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('reads back refreshed active keychain credentials on macOS', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
  })

  it('reads back refreshed legacy keychain credentials on old Claude Code builds', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = originalCredentials
    testState.legacyKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(refreshedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(refreshedCredentials)
  })

  it('rejects stale legacy keychain credentials after a fresher managed write', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', null, 1_000)
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed-newer',
      null,
      2_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = staleCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(managedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(managedCredentials)
  })

  it('uses fresher file credentials when scoped keychain is stale', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', null, 1_000)
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed',
      null,
      2_000
    )
    const refreshedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'refreshed',
      null,
      3_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = staleCredentials
    testState.legacyKeychainCredentials = managedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(refreshedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(refreshedCredentials)
  })

  it('restores system default when mismatched Claude keychain auth appears before deselect', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalKeychainCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = externalKeychainCredentials
    testState.legacyKeychainCredentials = externalKeychainCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalKeychainCredentials)
    expect(testState.legacyKeychainCredentials).toBe(externalKeychainCredentials)
  })

  it('restores unchanged scoped keychain while preserving external legacy keychain logout', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    testState.legacyKeychainCredentials = null
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('preserves external scoped keychain login while restoring unchanged legacy keychain', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalScopedCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { readActiveClaudeKeychainCredentials } = await import('./keychain')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    expect(readActiveClaudeKeychainCredentials).toHaveBeenCalledWith(expectedRuntimeConfigDir())

    testState.scopedKeychainCredentials = externalScopedCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalScopedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('restores oauth metadata when credentials prove managed ownership', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    const externalOauthAccount = { accountUuid: 'external-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: externalOauthAccount })}\n`,
      'utf-8'
    )
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('restores owned oauth metadata when external credentials change but metadata does not', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(externalCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('restores owned oauth metadata when only keychain proves managed ownership', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      'null\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(externalCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('uses managed credentials as ownership baseline after restart with partial external changes', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalScopedCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: null,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = externalScopedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalScopedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('preserves external file and scoped login while restoring unchanged legacy keychain', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    testState.scopedKeychainCredentials = externalCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(externalCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('restores legacy keychain credentials from old system-default snapshots', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: null,
        keychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not recapture managed file as system default after a partial keychain write failure', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    testState.throwRuntimeKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('runtime keychain write failed')

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    testState.throwRuntimeKeychainWrite = false
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('restores scoped keychain after legacy runtime keychain write fails', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    testState.throwLegacyRuntimeKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow(
      'legacy runtime keychain write failed'
    )

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('keeps managed ownership baseline when keychain restore fails and retries', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    testState.throwScopedKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain write failed')

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
    testState.throwScopedKeychainWrite = false
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('preserves previous keychain snapshot after restart following partial restore failure', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    let service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    testState.throwScopedKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain write failed')

    testState.throwScopedKeychainWrite = false
    service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not enter managed mode when keychain snapshot capture fails', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    testState.throwScopedKeychainRead = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow(
      'Cannot capture current Claude Keychain credentials'
    )

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
    warn.mockRestore()
  })
})
