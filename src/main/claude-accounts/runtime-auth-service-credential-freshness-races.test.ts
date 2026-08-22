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
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type * as FsUtils from '../codex-accounts/fs-utils'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import { readActiveClaudeKeychainCredentialsStrict } from './keychain'

const guardedWriteTestState = vi.hoisted(() => ({ beforeWrite: null as (() => void) | null }))

vi.mock('../codex-accounts/fs-utils', async () => {
  const actual = await vi.importActual<typeof FsUtils>('../codex-accounts/fs-utils')
  return {
    ...actual,
    writeFileAtomicallyIfUnchanged: (
      ...args: Parameters<typeof actual.writeFileAtomicallyIfUnchanged>
    ) => {
      guardedWriteTestState.beforeWrite?.()
      guardedWriteTestState.beforeWrite = null
      return actual.writeFileAtomicallyIfUnchanged(...args)
    }
  }
})

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

describe('ClaudeRuntimeAuthService credential freshness races', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    guardedWriteTestState.beforeWrite = null
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('does not let an embedded UUID override conflicting runtime OAuth metadata', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'runtime',
      'org-a',
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
    writeFileSync(runtimeCredentialsPath, runtimeCredentials, 'utf-8')
    writeFileSync(
      join(testState.fakeHomeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: {
          accountUuid: 'account-1',
          emailAddress: 'one@example.com',
          organizationUuid: 'org-b'
        }
      })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = runtimeCredentials
    testState.legacyKeychainCredentials = runtimeCredentials
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

  it('still switches accounts when the incoming identity is older', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const accountOne = createClaudeCredentialsJson('one@example.com', 'one', null, 9_000)
    const accountTwoOlder = createClaudeCredentialsJson('two@example.com', 'two-older', null, 1_000)
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', accountOne)
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      accountTwoOlder
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
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(accountOne)

    store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(accountTwoOlder)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(accountOne)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(accountTwoOlder)
  })

  it('does not let a failed refresh materialize an older managed snapshot over a fresh login', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const freshLogin = createClaudeCredentialsJson(
      'one@example.com',
      'fresh-login',
      null,
      9_999_999_999_999
    )
    const expiredManaged = createClaudeCredentialsJson(
      'one@example.com',
      'expired-managed',
      null,
      1_000
    )
    writeFileSync(runtimeCredentialsPath, freshLogin, 'utf-8')
    testState.scopedKeychainCredentials = freshLogin
    testState.legacyKeychainCredentials = freshLogin
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      expiredManaged
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const actualOauthRefresh = await vi.importActual<{
      isOauthTokenExpiring: typeof isOauthTokenExpiring
    }>('./oauth-refresh')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    vi.mocked(isOauthTokenExpiring).mockImplementation(actualOauthRefresh.isOauthTokenExpiring)
    try {
      vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
      store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
      await service.syncForCurrentSelection()

      expect(refreshClaudeOauthCredentials).toHaveBeenCalled()
      expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshLogin)
      expect(testState.scopedKeychainCredentials).toBe(freshLogin)
      expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(freshLogin)
    } finally {
      vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
    }
  })

  it('does not log credential payloads when managed adoption fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const freshRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'synthetic-secret',
      null,
      9_000
    )
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      1_000
    )
    writeFileSync(
      join(testState.fakeHomeDir, '.claude', '.credentials.json'),
      freshRuntime,
      'utf-8'
    )
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
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    testState.throwManagedKeychainWrite = true

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('synthetic-secret')
    warn.mockRestore()
  })

  it('serializes concurrent syncs so a stale materialize cannot win the last write', async () => {
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
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await Promise.all([
      service.syncForCurrentSelection(),
      service.syncForCurrentSelection(),
      service.syncForCurrentSelection()
    ])

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(freshRuntime)
    expect(testState.scopedKeychainCredentials).toBe(freshRuntime)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(freshRuntime)
  })

  it('rechecks the file after keychain reads before a concurrent writer can be clobbered', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleCredentials = createClaudeCredentialsJson('one@example.com', 'stale', null, 1_000)
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      9_000
    )
    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    testState.scopedKeychainCredentials = staleCredentials
    testState.legacyKeychainCredentials = staleCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleCredentials
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
    testState.onLegacyKeychainRead = () => {
      testState.onLegacyKeychainRead = null
      writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')
    }

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(concurrentRefresh)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(concurrentRefresh)
  })

  it('reads the file after keychain waits during steady-state read-back', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'managed',
      null,
      1_000
    )
    const staleReadBack = createClaudeCredentialsJson(
      'one@example.com',
      'stale-read-back',
      null,
      5_000
    )
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      9_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
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
    writeFileSync(runtimeCredentialsPath, staleReadBack, 'utf-8')
    testState.scopedKeychainCredentials = staleReadBack
    testState.legacyKeychainCredentials = staleReadBack
    testState.onLegacyKeychainRead = () => {
      testState.onLegacyKeychainRead = null
      writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')
    }

    await service.prepareForClaudeLaunch()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(concurrentRefresh)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(concurrentRefresh)
  })

  it('does not overwrite a newer external write published during managed adoption', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleManaged = createClaudeCredentialsJson(
      'one@example.com',
      'stale-managed',
      null,
      1_000
    )
    const observedRuntime = createClaudeCredentialsJson('one@example.com', 'observed', null, 9_000)
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      10_000
    )
    writeFileSync(runtimeCredentialsPath, observedRuntime, 'utf-8')
    testState.scopedKeychainCredentials = observedRuntime
    testState.legacyKeychainCredentials = observedRuntime
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
    testState.onManagedKeychainWrite = () => {
      testState.onManagedKeychainWrite = null
      writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')
      testState.scopedKeychainCredentials = concurrentRefresh
      testState.legacyKeychainCredentials = concurrentRefresh
    }

    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(concurrentRefresh)
    expect(testState.scopedKeychainCredentials).toBe(concurrentRefresh)
    expect(testState.legacyKeychainCredentials).toBe(concurrentRefresh)

    await service.syncForCurrentSelection()
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(concurrentRefresh)
  })

  it('revalidates before publishing a read-back after managed persistence', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'managed',
      null,
      1_000
    )
    const observedRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'observed-refresh',
      null,
      9_000
    )
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      10_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, observedRefresh, 'utf-8')
    testState.scopedKeychainCredentials = observedRefresh
    testState.legacyKeychainCredentials = observedRefresh
    testState.onManagedKeychainWrite = () => {
      testState.onManagedKeychainWrite = null
      writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')
      testState.scopedKeychainCredentials = concurrentRefresh
      testState.legacyKeychainCredentials = concurrentRefresh
    }

    await service.prepareForClaudeLaunch()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(concurrentRefresh)
    expect(testState.scopedKeychainCredentials).toBe(concurrentRefresh)
    expect(testState.legacyKeychainCredentials).toBe(concurrentRefresh)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(concurrentRefresh)
  })

  it('revalidates a post-observation file write before publication', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'managed',
      null,
      1_000
    )
    const observedRuntime = createClaudeCredentialsJson('one@example.com', 'observed', null, 9_000)
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      10_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const account = createClaudeAccount('account-1', managedAuthPath, {
      email: 'one@example.com'
    })
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [account],
        activeClaudeManagedAccountId: account.id
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never) as unknown as {
      protectRuntimeFileCredentialWrite: (
        selectedAccount: ClaudeManagedAccount,
        candidateCredentialsJson: string,
        managedCredentialsJson: string,
        preferCandidateOnEqual: boolean,
        candidateProvenance: 'unverified' | 'verified-refresh' | 'verified-adoption'
      ) => { credentialsJson: string }
    }
    writeFileSync(runtimeCredentialsPath, observedRuntime, 'utf-8')
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(observedRuntime)
    writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')

    expect(
      service.protectRuntimeFileCredentialWrite(
        account,
        observedRuntime,
        managedCredentials,
        false,
        'unverified'
      )
    ).toMatchObject({ credentialsJson: concurrentRefresh })
  })

  it('does not publish over a runtime refresh that lands after final revalidation', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'original',
      null,
      1_000
    )
    const managedRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'managed-refresh',
      null,
      9_000
    )
    const concurrentRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'concurrent-refresh',
      null,
      10_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'one@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    testState.managedKeychainCredentials.set('account-1', managedRefresh)
    writeFileSync(join(managedAuthPath, '.credentials.json'), managedRefresh, 'utf-8')
    guardedWriteTestState.beforeWrite = () => {
      writeFileSync(runtimeCredentialsPath, concurrentRefresh, 'utf-8')
      testState.scopedKeychainCredentials = concurrentRefresh
      testState.legacyKeychainCredentials = concurrentRefresh
    }

    await service.prepareForClaudeLaunch()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(concurrentRefresh)
    expect(testState.scopedKeychainCredentials).toBe(concurrentRefresh)
    expect(testState.legacyKeychainCredentials).toBe(concurrentRefresh)
    warn.mockRestore()
  })

  it('revalidates keychain credentials before steady-state publication', async () => {
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'managed',
      null,
      9_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
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
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockClear()

    await service.prepareForClaudeLaunch()

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledTimes(2)
  })

  it('rejects a later observed same-account refresh with an older expiry', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'managed',
      null,
      9_000
    )
    const shorterRefresh = createClaudeCredentialsJson(
      'one@example.com',
      'shorter-refresh',
      null,
      2_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
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

    writeFileSync(runtimeCredentialsPath, shorterRefresh, 'utf-8')
    testState.scopedKeychainCredentials = shorterRefresh
    testState.legacyKeychainCredentials = shorterRefresh
    await service.prepareForClaudeLaunch()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(managedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(managedCredentials)
  })

  it('recovers from a far-future runtime expiry after explicit re-auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const previousRuntime = createClaudeCredentialsJson(
      'one@example.com',
      'previous-runtime',
      null,
      9_000_000_000_000_000
    )
    const reauthedManaged = createClaudeCredentialsJson(
      'one@example.com',
      'reauthed-managed',
      null,
      2_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      previousRuntime
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
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(previousRuntime)

    // Simulate add/re-auth writing managed storage then clearing the last-written baseline.
    testState.managedKeychainCredentials.set('account-1', reauthedManaged)
    writeFileSync(join(managedAuthPath, '.credentials.json'), reauthedManaged, 'utf-8')
    writeFileSync(runtimeCredentialsPath, previousRuntime, 'utf-8')
    testState.scopedKeychainCredentials = previousRuntime
    testState.legacyKeychainCredentials = previousRuntime
    service.clearLastWrittenCredentialsJson('account-1')
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(reauthedManaged)
    expect(testState.scopedKeychainCredentials).toBe(reauthedManaged)
    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(reauthedManaged)
  })
})
