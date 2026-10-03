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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials,
  refreshClaudeOauthCredentialsWithOutcome
} from './oauth-refresh'

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

const FAR_FUTURE = 9_999_999_999_999

// Why: switching accounts while a Claude terminal runs must not write the target's
// unrefreshed (possibly dead) token over every live session.
describe('ClaudeRuntimeAuthService switch-in refresh with live Claude sessions', () => {
  const account1 = createClaudeCredentialsJson('one@example.com', 'one', null, FAR_FUTURE)
  let account2Stale: string
  let account2Refreshed: string

  beforeEach(() => {
    resetRuntimeAuthTestState()
    account2Stale = createClaudeCredentialsJson('two@example.com', 'two-stale', null, 1_000)
    account2Refreshed = createClaudeCredentialsJson(
      'two@example.com',
      'two-refreshed',
      null,
      FAR_FUTURE
    )
    vi.mocked(isOauthTokenExpiring).mockImplementation((json: string) => json === account2Stale)
  })

  afterEach(() => {
    vi.mocked(isOauthTokenExpiring).mockImplementation(() => false)
    cleanupRuntimeAuthTestState()
  })

  async function setUpAccount1ActiveWithAccount2Expiring() {
    const managedAuthPath1 = createManagedClaudeAuth(testState.userDataDir, 'account-1', account1)
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Stale
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
          createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const gate = await import('./live-pty-gate')
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()
    return {
      service,
      store,
      gate,
      managedAuthPath2,
      runtimeCredentialsPath: join(testState.fakeHomeDir, '.claude', '.credentials.json')
    }
  }

  it('refreshes the target before materializing it when live sessions belong to another account', async () => {
    const { service, store, gate, managedAuthPath2, runtimeCredentialsPath } =
      await setUpAccount1ActiveWithAccount2Expiring()
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValueOnce(account2Refreshed)

    gate.markClaudePtySpawned('live-claude-pty', 'managed:account-1')
    try {
      store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
      await service.syncForCurrentSelection()
    } finally {
      gate.markClaudePtyExited('live-claude-pty')
    }

    expect(refreshClaudeOauthCredentialsWithOutcome).toHaveBeenCalledWith(account2Stale)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Refreshed)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Refreshed)
  })

  it('aborts the switch instead of writing a dead refresh token over live sessions', async () => {
    const { service, store, gate, managedAuthPath2, runtimeCredentialsPath } =
      await setUpAccount1ActiveWithAccount2Expiring()
    vi.mocked(refreshClaudeOauthCredentialsWithOutcome).mockResolvedValueOnce({ kind: 'rejected' })

    gate.markClaudePtySpawned('live-claude-pty', 'managed:account-1')
    try {
      store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
      await expect(service.syncForCurrentSelection()).rejects.toThrow(
        'The Claude sign-in for two@example.com has expired'
      )
    } finally {
      gate.markClaudePtyExited('live-claude-pty')
    }

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Stale)
  })

  it('still materializes the target after a transient refresh failure', async () => {
    const { service, store, gate, runtimeCredentialsPath } =
      await setUpAccount1ActiveWithAccount2Expiring()

    gate.markClaudePtySpawned('live-claude-pty', 'managed:account-1')
    try {
      store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
      await service.syncForCurrentSelection()
    } finally {
      gate.markClaudePtyExited('live-claude-pty')
    }

    // Why: an expired access token with a live refresh token is survivable; the CLI refreshes it.
    expect(refreshClaudeOauthCredentialsWithOutcome).toHaveBeenCalledWith(account2Stale)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Stale)
  })

  it.each([
    ['launched under the target account', 'managed:account-2'],
    ['with unknown lineage', undefined]
  ])(
    'keeps deferring the target refresh while a session %s is live',
    async (_label, provenance) => {
      const { service, store, gate, runtimeCredentialsPath } =
        await setUpAccount1ActiveWithAccount2Expiring()

      gate.markClaudePtySpawned('live-claude-pty', provenance)
      try {
        store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
        const preparation = await service.prepareForRateLimitFetch()
        expect(preparation.managedRefreshDeferredByLivePty).toBe(true)
      } finally {
        gate.markClaudePtyExited('live-claude-pty')
      }

      expect(refreshClaudeOauthCredentialsWithOutcome).not.toHaveBeenCalled()
      expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Stale)
    }
  )

  it('keeps deferring a same-account re-sync even when live sessions launched under another account', async () => {
    const { service, store, gate } = await setUpAccount1ActiveWithAccount2Expiring()
    store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
    await service.syncForCurrentSelection()
    vi.mocked(refreshClaudeOauthCredentialsWithOutcome).mockClear()

    // Why: once materialized, every live session reads this account from the shared slot,
    // so any of them may be rotating it regardless of where it launched.
    gate.markClaudePtySpawned('live-claude-pty', 'managed:account-1')
    try {
      await service.syncForCurrentSelection()
    } finally {
      gate.markClaudePtyExited('live-claude-pty')
    }

    expect(refreshClaudeOauthCredentialsWithOutcome).not.toHaveBeenCalled()
  })
})
