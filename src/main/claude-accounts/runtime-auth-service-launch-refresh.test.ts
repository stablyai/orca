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
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'

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

  it('does not clobber fresh Claude credentials after clearLastWrittenCredentialsJson', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const reauthedCredentials = createClaudeCredentialsJson('user@example.com', 'reauthed')
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

    testState.managedKeychainCredentials.set('account-1', reauthedCredentials)
    writeFileSync(join(managedAuthPath, '.credentials.json'), reauthedCredentials, 'utf-8')
    service.clearLastWrittenCredentialsJson()
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(reauthedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(reauthedCredentials)
  })

  it('leaves host system-default credentials untouched before launch', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const expired = createClaudeCredentialsJson('system@example.com', 'system-expired', null, 1_000)
    writeFileSync(runtimeCredentialsPath, expired, 'utf-8')
    testState.scopedKeychainCredentials = expired
    testState.legacyKeychainCredentials = expired
    const settings = createSettings({
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)

    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(
      createClaudeCredentialsJson('system@example.com', 'system-refreshed')
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(isOauthTokenExpiring).not.toHaveBeenCalled()
    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
    expect(preparation.provenance).toBe('system')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(expired)
    expect(testState.scopedKeychainCredentials).toBe(expired)
    expect(testState.legacyKeychainCredentials).toBe(expired)

    vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
  })

  it('proactively refreshes and persists an expiring account on switch-in', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Stale = createClaudeCredentialsJson('one@example.com', 'one-stale', null, 1_000)
    const account1Refreshed = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed',
      null,
      9_999_999_999_999
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Stale
    )
    // Start on the system default (no active managed account), then switch in.
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // Now switch into account-1: token is expiring, so the service must refresh
    // and persist the rotation before materializing.
    vi.mocked(isOauthTokenExpiring).mockReturnValueOnce(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValueOnce(account1Refreshed)
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(refreshClaudeOauthCredentials).toHaveBeenCalledWith(account1Stale)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1Refreshed)
  })

  it('refreshes the active account with an expired token when no Claude PTY is live', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const expired = createClaudeCredentialsJson('one@example.com', 'one-expired', null, 1_000)
    const refreshedCreds = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed',
      null,
      9_999_999_999_999
    )
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', expired)
    // account-1 is ALREADY the active account (seeded), so this is a re-sync of
    // the active account, not a switch-in — the path that was previously missed.
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(refreshedCreds)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(refreshClaudeOauthCredentials).toHaveBeenCalled()
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(refreshedCreds)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCreds)

    vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
  })

  it('does not refresh the active account while a Claude PTY is live', async () => {
    const expired = createClaudeCredentialsJson('one@example.com', 'one-expired', null, 1_000)
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', expired)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(
      createClaudeCredentialsJson('one@example.com', 'should-not-be-used', null, 9_999_999_999_999)
    )

    const { markClaudePtySpawned, markClaudePtyExited } = await import('./live-pty-gate')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    markClaudePtySpawned('pty-live-1')
    try {
      const preparation = await service.prepareForRateLimitFetch()
      // A live Claude owns the credentials; refreshing here would race its
      // rotation, so the proactive refresh must be skipped entirely.
      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      expect(preparation.managedRefreshDeferredByLivePty).toBe(true)
    } finally {
      markClaudePtyExited('pty-live-1')
      vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
      vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
    }
  })

  it('adopts a rotated-refresh-token runtime credential on cold-start read-back', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    // Same expiry on both sides (cold start), but the runtime refresh token has
    // rotated — proof the CLI refreshed. Must be read back into managed storage.
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-old',
      null,
      3_000
    )
    const runtimeRotated = `${JSON.stringify({
      claudeAiOauth: {
        email: 'one@example.com',
        accessToken: 'one-rotated',
        refreshToken: 'one-rotated-refresh',
        expiresAt: 3_000
      }
    })}\n`
    writeFileSync(runtimeCredentialsPath, runtimeRotated, 'utf-8')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(runtimeRotated)
  })
})
