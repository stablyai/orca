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
  hostPlatform,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'

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

  it('rematerializes unchanged managed credentials when the runtime file is missing', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
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

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)

    rmSync(runtimeCredentialsPath, { force: true })
    await service.prepareForClaudeLaunch()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
    expect(testState.runtimeWriteConfigDir).toBe(expectedRuntimeConfigDir())
  })

  it('restores system default instead of materializing corrupt managed credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{not-json')
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('restores system default instead of materializing wrong-shaped managed credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', '{}\n')
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not materialize managed credentials from unowned auth paths', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const unownedAuthPath = join(testState.fakeHomeDir, 'unowned-claude-auth')
    mkdirSync(unownedAuthPath, { recursive: true })
    writeFileSync(join(unownedAuthPath, '.credentials.json'), managedCredentials, 'utf-8')
    writeFileSync(
      join(unownedAuthPath, 'oauth-account.json'),
      `${JSON.stringify({ accountUuid: 'account-1' })}\n`,
      'utf-8'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', unownedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('adopts canonical legacy managed auth paths without existing markers', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.credentials.json'), managedCredentials, 'utf-8')
    writeFileSync(
      join(managedAuthPath, 'oauth-account.json'),
      '{"accountUuid":"account-1"}\n',
      'utf-8'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    const markerPath = join(managedAuthPath, '.orca-managed-claude-auth')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
    expect(lstatSync(markerPath).isFile()).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).toBe('account-1\n')
  })

  it('rejects symlinked managed credential children', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const escapedCredentials = createClaudeCredentialsJson('user@example.com', 'escaped')
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    const escapedCredentialsPath = join(testState.fakeHomeDir, 'escaped-credentials.json')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(managedAuthPath, 'oauth-account.json'),
      '{"accountUuid":"account-1"}\n',
      'utf-8'
    )
    writeFileSync(escapedCredentialsPath, escapedCredentials, 'utf-8')
    symlinkSync(escapedCredentialsPath, join(managedAuthPath, '.credentials.json'))
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('restores system auth when switching from an owned account to an unowned account', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const ownedCredentials = createClaudeCredentialsJson('owned@example.com', 'owned')
    const unownedCredentials = createClaudeCredentialsJson('unowned@example.com', 'unowned')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const ownedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      ownedCredentials
    )
    const unownedAuthPath = join(testState.fakeHomeDir, 'unowned-claude-auth')
    mkdirSync(unownedAuthPath, { recursive: true })
    writeFileSync(join(unownedAuthPath, '.credentials.json'), unownedCredentials, 'utf-8')
    let settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', ownedAuthPath, { email: 'owned@example.com' }),
        createClaudeAccount('account-2', unownedAuthPath, { email: 'unowned@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
        settings = {
          ...settings,
          ...updates,
          notifications: {
            ...settings.notifications,
            ...updates.notifications
          }
        }
        return settings
      })
    }

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(ownedCredentials)

    store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('restores system auth when the previously synced account is no longer in settings', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const ownedCredentials = createClaudeCredentialsJson('owned@example.com', 'owned')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const ownedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      ownedCredentials
    )
    const unownedAuthPath = join(testState.fakeHomeDir, 'unowned-claude-auth')
    mkdirSync(unownedAuthPath, { recursive: true })
    let settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', ownedAuthPath, { email: 'owned@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
        settings = {
          ...settings,
          ...updates,
          notifications: {
            ...settings.notifications,
            ...updates.notifications
          }
        }
        return settings
      })
    }

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(ownedCredentials)

    store.updateSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-2', unownedAuthPath, { email: 'unowned@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('restores system auth when switching from an owned account to missing credentials', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = join(testState.userDataDir, 'claude-accounts', 'account-2', 'auth')
    mkdirSync(managedAuthPath2, { recursive: true })
    writeFileSync(join(managedAuthPath2, '.orca-managed-claude-auth'), 'account-2\n', 'utf-8')
    writeFileSync(
      join(managedAuthPath2, 'oauth-account.json'),
      '{"accountUuid":"account-2"}\n',
      'utf-8'
    )
    let settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
        settings = {
          ...settings,
          ...updates,
          notifications: {
            ...settings.notifications,
            ...updates.notifications
          }
        }
        return settings
      })
    }

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1Credentials)

    store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
    await service.syncForCurrentSelection()

    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('removes runtime credentials when deselecting with a missing system-default snapshot', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
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

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBeNull()
      expect(testState.legacyKeychainCredentials).toBeNull()
    }
  })

  it('falls back to atomic write when the unchanged check cannot read the target', async () => {
    if (hostPlatform === 'win32') {
      return
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const rotatedCredentials = createClaudeCredentialsJson('user@example.com', 'rotated')
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

    testState.managedKeychainCredentials.set('account-1', rotatedCredentials)
    writeFileSync(join(managedAuthPath, '.credentials.json'), rotatedCredentials, 'utf-8')
    chmodSync(runtimeCredentialsPath, 0o000)
    try {
      await service.syncForCurrentSelection()
    } finally {
      if (existsSync(runtimeCredentialsPath)) {
        chmodSync(runtimeCredentialsPath, 0o600)
      }
      warn.mockRestore()
    }

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(rotatedCredentials)
  })

  it('tightens credential file permissions when unchanged content is already present', async () => {
    if (hostPlatform === 'win32') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
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
    chmodSync(runtimeCredentialsPath, 0o644)
    await service.syncForCurrentSelection()

    expect(statSync(runtimeCredentialsPath).mode & 0o777).toBe(0o600)
  })
})
