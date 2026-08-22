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
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

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

describe('ClaudeRuntimeAuthService monotonic credential freshness', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('falls back to the owned managed file when the Keychain item is malformed', async () => {
    const managedCredentials = createClaudeCredentialsJson('one@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    testState.managedKeychainCredentials.set('account-1', '{malformed')
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await expect(service.prepareForClaudeLaunch()).resolves.toMatchObject({
      provenance: 'managed:account-1'
    })
  })

  it('does not overwrite a fresher same-identity runtime file with an older managed snapshot', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const freshRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-runtime',
      null,
      9_000
    )
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      1_000
    )
    writeFileSync(runtimeCredentialsPath, freshRuntime, 'utf-8')
    testState.scopedKeychainCredentials = freshRuntime
    testState.legacyKeychainCredentials = freshRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      // Deselected so first selection materializes without a prior lastWritten baseline.
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshRuntime)
    expect(testState.scopedKeychainCredentials).toBe(freshRuntime)
    expect(testState.legacyKeychainCredentials).toBe(freshRuntime)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(freshRuntime)
  })

  it('preserves a newer same-identity runtime file on Linux', async () => {
    setPlatform('linux')
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const freshRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-runtime',
      null,
      9_000
    )
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      1_000
    )
    writeFileSync(runtimeCredentialsPath, freshRuntime, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshRuntime)
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(freshRuntime)
  })

  it('continues launch and updates the file when a Keychain freshness read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'stale-runtime',
      null,
      1_000
    )
    const freshManaged = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-managed',
      null,
      9_000
    )
    writeFileSync(runtimeCredentialsPath, staleRuntime, 'utf-8')
    testState.scopedKeychainCredentials = staleRuntime
    testState.legacyKeychainCredentials = staleRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      freshManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleRuntime, 'utf-8')
    testState.scopedKeychainCredentials = staleRuntime
    testState.legacyKeychainCredentials = staleRuntime
    testState.throwScopedKeychainRead = true
    try {
      await expect(service.prepareForClaudeLaunch()).resolves.toMatchObject({
        provenance: 'managed:account-1'
      })
    } finally {
      testState.throwScopedKeychainRead = false
      warn.mockRestore()
    }

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshManaged)
    expect(testState.scopedKeychainCredentials).toBe(staleRuntime)
    expect(testState.legacyKeychainCredentials).toBe(staleRuntime)
  })

  it('materializes the selected account when same-identity expiries are equal', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeEqual = createClaudeCredentialsJson(
      'one@example.com',
      'runtime-equal',
      null,
      5_000
    )
    const managedEqual = createClaudeCredentialsJson(
      'one@example.com',
      'managed-equal',
      null,
      5_000
    )
    writeFileSync(runtimeCredentialsPath, runtimeEqual, 'utf-8')
    testState.scopedKeychainCredentials = runtimeEqual
    testState.legacyKeychainCredentials = runtimeEqual
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedEqual
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedEqual)
    expect(testState.scopedKeychainCredentials).toBe(managedEqual)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(managedEqual)
  })

  it('keeps a dated runtime when the managed snapshot has missing or invalid expiresAt', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const datedRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'dated-runtime',
      null,
      9_000
    )
    const parsedManaged = JSON.parse(
      createClaudeCredentialsJson('one@example.com', 'invalid-expiry', null, 1_000)
    ) as { claudeAiOauth: Record<string, unknown> }
    const invalidExpiryManaged = JSON.stringify({
      ...parsedManaged,
      claudeAiOauth: {
        ...parsedManaged.claudeAiOauth,
        expiresAt: 'not-a-number'
      }
    })
    writeFileSync(runtimeCredentialsPath, datedRuntime, 'utf-8')
    testState.scopedKeychainCredentials = datedRuntime
    testState.legacyKeychainCredentials = datedRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      invalidExpiryManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(datedRuntime)
    expect(testState.scopedKeychainCredentials).toBe(datedRuntime)
  })

  it('preserves a re-read unknown-expiry file over stale finite keychain stores', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const unknownExpiryRuntime = `${JSON.stringify({
      claudeAiOauth: {
        email: 'one@example.com',
        accessToken: 'unknown-new-login',
        refreshToken: 'unknown-new-login-refresh',
        expiresAt: 'not-a-number'
      }
    })}\n`
    const staleFiniteCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'stale-finite',
      null,
      1_000
    )
    writeFileSync(runtimeCredentialsPath, unknownExpiryRuntime, 'utf-8')
    testState.scopedKeychainCredentials = staleFiniteCredentials
    testState.legacyKeychainCredentials = staleFiniteCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleFiniteCredentials
    )
    const account = createClaudeAccount('account-1', managedAuthPath, {
      email: 'one@example.com'
    })
    const settings = createSettings({
      claudeManagedAccounts: [account],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never) as unknown as {
      syncForCurrentSelection(): Promise<void>
      prepareMonotonicRuntimeMaterialization(
        selectedAccount: ClaudeManagedAccount,
        candidateCredentialsJson: string,
        observation: undefined,
        preferCandidateOnEqual: boolean,
        candidateProvenance: 'unverified' | 'verified-refresh' | 'verified-adoption'
      ): Promise<{ credentialsJson: string }>
    }
    await service.syncForCurrentSelection()

    await expect(
      service.prepareMonotonicRuntimeMaterialization(
        account,
        staleFiniteCredentials,
        undefined,
        true,
        'unverified'
      )
    ).resolves.toMatchObject({ credentialsJson: unknownExpiryRuntime })
    await expect(
      service.prepareMonotonicRuntimeMaterialization(
        account,
        staleFiniteCredentials,
        undefined,
        true,
        'verified-adoption'
      )
    ).resolves.toMatchObject({ credentialsJson: staleFiniteCredentials })

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(unknownExpiryRuntime)
    expect(testState.scopedKeychainCredentials).toBe(unknownExpiryRuntime)
    expect(testState.legacyKeychainCredentials).toBe(unknownExpiryRuntime)
  })

  it('uses the freshest of diverged file/keychain stores before materializing', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleFile = createClaudeCredentialsJson('one@example.com', 'stale-file', null, 1_000)
    const fresherKeychain = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-keychain',
      null,
      9_000
    )
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, staleFile, 'utf-8')
    testState.scopedKeychainCredentials = fresherKeychain
    testState.legacyKeychainCredentials = staleFile
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(fresherKeychain)
    expect(testState.scopedKeychainCredentials).toBe(fresherKeychain)
    expect(testState.legacyKeychainCredentials).toBe(fresherKeychain)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(fresherKeychain)
  })

  it('does not let another account keychain mask a fresher same-account file', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const freshAccountFile = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-account-file',
      null,
      9_000
    )
    const otherAccountKeychain = createClaudeCredentialsJson(
      'two@example.com',
      'other-account-keychain',
      null,
      12_000
    )
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, freshAccountFile, 'utf-8')
    testState.scopedKeychainCredentials = otherAccountKeychain
    testState.legacyKeychainCredentials = otherAccountKeychain
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshAccountFile)
    expect(testState.scopedKeychainCredentials).toBe(freshAccountFile)
    expect(testState.legacyKeychainCredentials).toBe(freshAccountFile)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(freshAccountFile)
  })

  it('does not adopt a newer unverified runtime into the selected managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const unverifiedRuntime = createClaudeCredentialsWithoutEmail('unverified-runtime', null, {
      expiresAt: 9_000,
      refreshToken: 'unverified-refresh'
    })
    const selectedManaged = createClaudeCredentialsJson(
      'one@example.com',
      'selected-managed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, unverifiedRuntime, 'utf-8')
    testState.scopedKeychainCredentials = unverifiedRuntime
    testState.legacyKeychainCredentials = unverifiedRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedManaged)
    expect(testState.scopedKeychainCredentials).toBe(selectedManaged)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedManaged)
  })

  it('does not adopt a newer credential with a conflicting runtime OAuth account UUID', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const otherAccountRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'other-account',
      null,
      9_000
    )
    const selectedManaged = createClaudeCredentialsJson(
      'one@example.com',
      'selected-managed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, otherAccountRuntime, 'utf-8')
    writeFileSync(
      join(testState.fakeHomeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: { accountUuid: 'account-b', emailAddress: 'one@example.com' }
      })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = otherAccountRuntime
    testState.legacyKeychainCredentials = otherAccountRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedManaged)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedManaged)
  })

  it('does not let a matching runtime OAuth UUID override a conflicting credential email', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const otherAccountRuntime = createClaudeCredentialsJson(
      'other@example.com',
      'other-account',
      null,
      9_000
    )
    const selectedManaged = createClaudeCredentialsJson(
      'one@example.com',
      'selected-managed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, otherAccountRuntime, 'utf-8')
    writeFileSync(
      join(testState.fakeHomeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: { accountUuid: 'account-1', emailAddress: 'other@example.com' }
      })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = otherAccountRuntime
    testState.legacyKeychainCredentials = otherAccountRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedManaged)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedManaged)
  })

  it('does not let an embedded UUID override a conflicting organization', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const otherOrganizationRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'other-organization',
      'org-b',
      9_000,
      'account-1'
    )
    const selectedManaged = createClaudeCredentialsJson(
      'one@example.com',
      'selected-managed',
      'org-a',
      2_000,
      'account-1'
    )
    writeFileSync(runtimeCredentialsPath, otherOrganizationRuntime, 'utf-8')
    testState.scopedKeychainCredentials = otherOrganizationRuntime
    testState.legacyKeychainCredentials = otherOrganizationRuntime
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, {
          email: 'one@example.com',
          organizationUuid: 'org-a'
        })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedManaged)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedManaged)
  })
})
