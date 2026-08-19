import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createClaudeCredentialsWithoutEmail,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  readManagedCredentialsForTest,
  readRuntimeOauthAccountForTest,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('restores the system default after rejecting unverifiable managed credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const originalCredentials = createClaudeCredentialsWithoutEmail('original')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('restores system default after same-identity managed Claude refresh on deselect', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed', 'org-1')
    const externalCredentials = createClaudeCredentialsJson('user@example.com', 'external', 'org-1')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, {
          organizationUuid: 'org-1'
        })
      ]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(externalCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('preserves external stale Claude credentials without writing them to managed storage', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const selectedCredentials = createClaudeCredentialsJson('selected@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('stale@example.com', 'stale')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'selected@example.com' })
      ]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not persist unverifiable stale Claude credentials into another active account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const staleUnverifiableCredentials = createClaudeCredentialsWithoutEmail('stale')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, staleUnverifiableCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('materializes only the selected managed account into shared Claude runtime files', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one-token')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two-token')
    const account1Oauth = '{"accountUuid":"account-1","emailAddress":"one@example.com"}\n'
    const account2Oauth = '{"accountUuid":"account-2","emailAddress":"two@example.com"}\n'
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials,
      account1Oauth
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials,
      account2Oauth
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1Credentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({
      accountUuid: 'account-1',
      emailAddress: 'one@example.com'
    })

    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({
      accountUuid: 'account-2',
      emailAddress: 'two@example.com'
    })

    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1Credentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({
      accountUuid: 'account-1',
      emailAddress: 'one@example.com'
    })

    // Why: switching rewrites only the shared Claude runtime surface; the
    // managed account files remain per-account sources of truth.
    expect(readFileSync(join(managedAuthPath1, '.credentials.json'), 'utf-8')).toBe(
      account1Credentials
    )
    expect(readFileSync(join(managedAuthPath2, '.credentials.json'), 'utf-8')).toBe(
      account2Credentials
    )
    expect(readFileSync(join(managedAuthPath1, 'oauth-account.json'), 'utf-8')).toBe(account1Oauth)
    expect(readFileSync(join(managedAuthPath2, 'oauth-account.json'), 'utf-8')).toBe(account2Oauth)
  })

  it('does not carry the reauth read-back skip across Claude account switches', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const account2RefreshedCredentials = createClaudeCredentialsJson(
      'two@example.com',
      'two-refreshed'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    service.clearLastWrittenCredentialsJson()
    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account2RefreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(
      account2RefreshedCredentials
    )
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2RefreshedCredentials)
  })

  it('does not apply inactive-account Claude reauth skip to the active account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account1RefreshedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed'
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account1RefreshedCredentials, 'utf-8')
    service.clearLastWrittenCredentialsJson('account-2')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(
      account1RefreshedCredentials
    )
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1RefreshedCredentials)
  })

  it('keeps external Claude logout when deselecting managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
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

    rmSync(runtimeCredentialsPath, { force: true })
    testState.activeKeychainCredentials = null
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('preserves unknown runtime auth when invalid active account has no ownership proof', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: systemOauthAccount,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, staleManagedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'missing-account' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      activeClaudeManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(store.updateSettings).toHaveBeenCalledWith({
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
    })
    expect(preparation.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    expect(preparation.stripAuthEnv).toBe(false)
    expect(preparation.provenance).toBe('system')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleManagedCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'missing-account' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })

  it('restores system snapshot when active account credentials are missing but runtime matches account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: systemOauthAccount,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, staleManagedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('system')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleManagedCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'account-1' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })

  it('keeps missing-managed selection until cleanup can retry after keychain failure', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: systemOauthAccount,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, staleManagedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    testState.throwScopedKeychainWrite = true
    const failedPreparation = await service.prepareForClaudeLaunch()

    expect(failedPreparation.provenance).toBe('system')
    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleManagedCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'account-1' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)

    testState.throwScopedKeychainWrite = false
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('system')
    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })

  it('restores missing-managed oauth metadata when only keychain proves ownership', async () => {
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: systemOauthAccount,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'managed@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.prepareForClaudeLaunch()

    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'account-1' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })

  it('preserves unknown runtime auth when invalid active account has no system snapshot', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const staleManagedCredentials = createClaudeCredentialsJson('managed@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, staleManagedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'missing-account' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = staleManagedCredentials
    testState.legacyKeychainCredentials = staleManagedCredentials
    const settings = createSettings({
      activeClaudeManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('system')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleManagedCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual({ accountUuid: 'missing-account' })
    expect(testState.scopedKeychainCredentials).toBe(staleManagedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(staleManagedCredentials)
  })
})
