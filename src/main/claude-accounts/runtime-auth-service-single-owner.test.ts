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
  resetRuntimeAuthTestState,
  setScopedKeychainCredentialsForManagedPath,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeActiveClaudeKeychainCredentials } from './keychain'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})
vi.mock('./keychain', () => createKeychainMock())

/**
 * The contract this refactor establishes: on macOS the Claude CLI's config-dir-scoped Keychain
 * item is the single owner of a managed account's credential. Orca reads it and never reconciles
 * a second copy onto it.
 */
describe('ClaudeRuntimeAuthService single-owner contract', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  async function launchWithScopedCredential(scopedValue: string) {
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(
        testState.userDataDir,
        'account-1',
        createClaudeCredentialsJson('user@example.com', 'orca-copy')
      )
    )
    // The CLI already owns a credential here, so migration has nothing to copy.
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, scopedValue)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.whenStartupMigrationsComplete()
    vi.mocked(writeActiveClaudeKeychainCredentials).mockClear()
    const preparation = await service.prepareForClaudeLaunch()
    return { managedAuthPath, preparation }
  }

  it('does not write the scoped Keychain item at launch', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const cliCredential = createClaudeCredentialsJson('user@example.com', 'cli-rotation')
    const { managedAuthPath, preparation } = await launchWithScopedCredential(cliCredential)

    // Ablation: restoring the launch-path `writeActiveClaudeKeychainCredentials(managed, ...)`
    // turns this red. That write is the whole bug — it replays Orca's copy of a single-use
    // refresh token over the CLI's freshly rotated one.
    expect(vi.mocked(writeActiveClaudeKeychainCredentials)).not.toHaveBeenCalled()
    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBe(managedAuthPath)
  })

  it("leaves a rotation the CLI wrote after Orca's own copy untouched", async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const cliRotation = createClaudeCredentialsJson('user@example.com', 'cli-rotation')
    const { managedAuthPath } = await launchWithScopedCredential(cliRotation)

    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath)).toBe(cliRotation)
  })

  it('routes a pane at its own config dir without reading a second store', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const cliCredential = createClaudeCredentialsJson('user@example.com', 'cli')
    const { managedAuthPath, preparation } = await launchWithScopedCredential(cliCredential)

    expect(preparation.configDir).toBe(managedAuthPath)
    expect(preparation.stripAuthEnv).toBe(true)
    expect(preparation.provenance.startsWith('managed:account-1')).toBe(true)
  })

  it('does not write managed credentials when switching away from an isolated account', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const own = createClaudeCredentialsJson('user@example.com', 'account-1')
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-1', own)
    )
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, own)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { markClaudePtyExited, markClaudePtySpawned } = await import('./live-pty-gate')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.whenStartupMigrationsComplete()
    await service.syncForCurrentSelection()

    // A live Claude plus a changed shared-runtime blob is exactly the state that used to trigger
    // the switch-away read-back and persist that blob into the account being left.
    markClaudePtySpawned('live-claude-pty')
    try {
      writeFileSync(
        join(testState.fakeHomeDir, '.claude', '.credentials.json'),
        createClaudeCredentialsJson('user@example.com', 'someone-elses-rotation'),
        'utf-8'
      )
      vi.mocked(writeActiveClaudeKeychainCredentials).mockClear()
      settings.activeClaudeManagedAccountId = null
      await service.syncForCurrentSelection()
    } finally {
      markClaudePtyExited('live-claude-pty')
    }

    // Ablation: removing the `previousIsIsolated` guard in runtime-auth-sync turns this red. An
    // isolated account's credentials were never materialized into the shared runtime, so anything
    // found there belongs to someone else or is already spent.
    expect(vi.mocked(writeActiveClaudeKeychainCredentials)).not.toHaveBeenCalled()
    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath)).toBe(own)
  })
})
