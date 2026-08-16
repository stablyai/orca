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
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
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

  it('reads back refreshed file credentials when keychain reads fail', async () => {
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    testState.throwScopedKeychainRead = true
    testState.throwLegacyKeychainRead = true
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
    warn.mockRestore()
  })

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials1 = createClaudeCredentialsJson('system1@example.com', 'system1')
    const systemCredentials2 = createClaudeCredentialsJson('system2@example.com', 'system2')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials1, 'utf-8')
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

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, systemCredentials2, 'utf-8')

    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials2)
  })

  it('refreshes keychain and oauth snapshot surfaces when the credentials file is unchanged', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials1 = createClaudeCredentialsJson('system1@example.com', 'system1')
    const systemCredentials2 = createClaudeCredentialsJson('system2@example.com', 'system2')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount1 = { accountUuid: 'system-account-1' }
    const systemOauthAccount2 = { accountUuid: 'system-account-2' }
    writeFileSync(runtimeCredentialsPath, systemCredentials1, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount1 })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials1
    testState.legacyKeychainCredentials = systemCredentials1
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
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount2 })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials2
    testState.legacyKeychainCredentials = systemCredentials2
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials1)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount2)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials2)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials2)
  })

  it('reads back refreshed credentials for the outgoing Claude account before switching', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
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

    writeFileSync(runtimeCredentialsPath, account1Refreshed, 'utf-8')
    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('switches accounts without persisting unverified live runtime credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original', 'org-a')
    const unverifiedLiveCredentials = createClaudeCredentialsWithoutEmail('one-live', 'org-b')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', 'org-c')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, {
          email: 'one@example.com',
          organizationUuid: 'org-a'
        }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'two@example.com',
          organizationUuid: 'org-c'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    markClaudePtySpawned('live-claude-pty')
    try {
      writeFileSync(runtimeCredentialsPath, unverifiedLiveCredentials, 'utf-8')
      settings.activeClaudeManagedAccountId = 'account-2'

      await service.syncForCurrentSelection()
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Original)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBe(account2Credentials)
    }
  })

  it('routes refreshed Claude credentials to the matching managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
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
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // A stale account-1 Claude process refreshed the shared runtime file after
    // Orca selected account-2. Persist that refresh to account-1, then restore
    // the selected account in the shared Claude runtime credentials.
    writeFileSync(runtimeCredentialsPath, account1Refreshed, 'utf-8')
    testState.scopedKeychainCredentials = account1Refreshed
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBe(account2Credentials)
      expect(testState.legacyKeychainCredentials).toBe(account2Credentials)
    }
  })

  it('rejects stale cold-start read-back for inactive matching account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1ManagedNewer = createClaudeCredentialsJson(
      'one@example.com',
      'one-managed-newer',
      null,
      5_000
    )
    const account1RuntimeStale = createClaudeCredentialsJson(
      'one@example.com',
      'one-runtime-stale',
      null,
      2_000
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', null, 1_000)
    writeFileSync(runtimeCredentialsPath, account1RuntimeStale, 'utf-8')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1ManagedNewer
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
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1ManagedNewer)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('rejects ambiguous Claude read-back instead of choosing a managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('same@example.com', 'same-original')
    const refreshedCredentials = createClaudeCredentialsJson('same@example.com', 'same-refreshed')
    const activeCredentials = createClaudeCredentialsJson('active@example.com', 'active')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      originalCredentials
    )
    const managedAuthPath3 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-3',
      activeCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'same@example.com' }),
        createClaudeAccount('account-3', managedAuthPath3, { email: 'active@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-3'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(originalCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(originalCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(activeCredentials)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBe(activeCredentials)
      expect(testState.legacyKeychainCredentials).toBe(activeCredentials)
    }
  })

  it('rejects same-email read-back when another account needs organization proof', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const refreshedWithoutOrg = createClaudeCredentialsJson('same@example.com', 'refreshed')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedWithoutOrg, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(noOrgCredentials)
  })

  it('ignores unrelated org-scoped accounts when reading back no-org credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account1RefreshedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed'
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', 'org-b')
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
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'two@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account1RefreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(
      account1RefreshedCredentials
    )
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1RefreshedCredentials)
  })

  it('rejects same-email read-back with conflicting organization for no-org accounts', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const conflictingOrgCredentials = createClaudeCredentialsJson(
      'same@example.com',
      'conflicting-org',
      'org-c'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, conflictingOrgCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(noOrgCredentials)
  })
})
