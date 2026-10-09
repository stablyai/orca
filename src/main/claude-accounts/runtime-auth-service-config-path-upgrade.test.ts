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
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => createElectronMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./live-pty-gate', () => ({ hasLiveClaudePtys: vi.fn(() => false) }))
const runWslProcess = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))
vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

describe('Claude runtime config path upgrade', () => {
  let previousConfigDir: string | undefined

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRuntimeAuthTestState()
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  const managedOauthAccount = { accountUuid: 'account-1', emailAddress: 'user@example.com' }
  const staleNestedOauthAccount = {
    accountUuid: 'stale-nested-account',
    emailAddress: 'stale@example.com'
  }

  /**
   * Reproduces a pre-fix install: the old resolver picked ~/.claude/.claude.json because it
   * existed, so the persisted snapshot holds that file's identity and the managed identity
   * was materialized there, while ~/.claude.json keeps the system identity.
   */
  async function seedLegacyNestedSnapshot(systemOauthAccount: Record<string, string>) {
    const rootConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const nestedConfigPath = join(testState.fakeHomeDir, '.claude', '.claude.json')
    const credentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const rootConfig = { oauthAccount: systemOauthAccount, hasCompletedOnboarding: true }
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      createClaudeCredentialsJson('user@example.com', 'managed'),
      JSON.stringify(managedOauthAccount)
    )
    writeFileSync(rootConfigPath, JSON.stringify(rootConfig))
    writeFileSync(nestedConfigPath, JSON.stringify({ oauthAccount: staleNestedOauthAccount }))
    writeFileSync(credentialsPath, systemCredentials)
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
        activeClaudeManagedAccountId: null
      })
    )
    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const oldPathResolver = vi
      .spyOn(ClaudeRuntimePathResolver.prototype, 'getRuntimePaths')
      .mockReturnValue({
        configDir: join(testState.fakeHomeDir, '.claude'),
        credentialsPath,
        configPath: nestedConfigPath,
        envPatch: {}
      })
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const oldService = new ClaudeRuntimeAuthService(store as never)
    await oldService.syncForCurrentSelection()
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await oldService.prepareForClaudeLaunch()

    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    // Simulate a snapshot written before config paths were recorded.
    const { configPath: _configPath, ...legacySnapshot } = JSON.parse(
      readFileSync(snapshotPath, 'utf-8')
    )
    writeFileSync(snapshotPath, JSON.stringify(legacySnapshot))
    expect(legacySnapshot).toMatchObject({
      credentialsJson: systemCredentials,
      configOauthAccount: staleNestedOauthAccount
    })
    return {
      ClaudeRuntimeAuthService,
      credentialsPath,
      oldPathResolver,
      rootConfig,
      rootConfigPath,
      store,
      systemCredentials
    }
  }

  it.each([false, true])(
    'never restores the stale nested identity after restart (corrected resolver: %s)',
    async (correctedResolver) => {
      const seeded = await seedLegacyNestedSnapshot({
        accountUuid: 'system-account',
        emailAddress: 'system@example.com'
      })
      if (correctedResolver) {
        seeded.oldPathResolver.mockRestore()
      }
      const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
      await service.prepareForClaudeLaunch()

      seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
      await service.syncForCurrentSelection()

      expect(readFileSync(seeded.credentialsPath, 'utf-8')).toBe(seeded.systemCredentials)
      expect(testState.scopedKeychainCredentials).toBe(seeded.systemCredentials)
      expect(testState.legacyKeychainCredentials).toBe(seeded.systemCredentials)
      // Why: with the corrected resolver the snapshot's source is unknown, so the identity is
      // cleared for Claude to repopulate; the old resolver never touched ~/.claude.json.
      expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual(
        correctedResolver ? { hasCompletedOnboarding: true } : seeded.rootConfig
      )
    }
  )

  it('clears a legacy nested snapshot identity when the system identity equals the managed one', async () => {
    const seeded = await seedLegacyNestedSnapshot({
      ...managedOauthAccount,
      displayName: 'System profile'
    })
    seeded.oldPathResolver.mockRestore()
    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await service.prepareForClaudeLaunch()

    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()

    // Why: the snapshot's source is unknown; Claude repopulates oauthAccount from its token's
    // profile on next start.
    expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })
  })

  it('never restores the stale identity when the first post-upgrade Keychain write fails', async () => {
    const seeded = await seedLegacyNestedSnapshot({
      accountUuid: 'system-account',
      emailAddress: 'system@example.com'
    })
    seeded.oldPathResolver.mockRestore()
    testState.throwRuntimeKeychainWrite = true
    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await expect(service.prepareForClaudeLaunch()).rejects.toThrow('runtime keychain write failed')

    expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })

    testState.throwRuntimeKeychainWrite = false
    await service.prepareForClaudeLaunch()
    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()

    expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })
  })

  /** Reproduces a pre-fix install without a nested config: snapshot and writes used ~/.claude.json. */
  async function seedLegacyRootSnapshot() {
    const rootConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const credentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const rootConfig = {
      oauthAccount: { accountUuid: 'system-account', emailAddress: 'system@example.com' },
      hasCompletedOnboarding: true
    }
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      createClaudeCredentialsJson('user@example.com', 'managed'),
      JSON.stringify(managedOauthAccount)
    )
    writeFileSync(rootConfigPath, JSON.stringify(rootConfig))
    writeFileSync(credentialsPath, systemCredentials)
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
        activeClaudeManagedAccountId: null
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const oldService = new ClaudeRuntimeAuthService(store as never)
    await oldService.syncForCurrentSelection()
    store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
    await oldService.prepareForClaudeLaunch()
    expect(JSON.parse(readFileSync(rootConfigPath, 'utf-8')).oauthAccount).toEqual(
      managedOauthAccount
    )

    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    // Simulate a snapshot written before config paths were recorded.
    const { configPath: _configPath, ...legacySnapshot } = JSON.parse(
      readFileSync(snapshotPath, 'utf-8')
    )
    writeFileSync(snapshotPath, JSON.stringify(legacySnapshot))
    expect(legacySnapshot.configOauthAccount).toEqual(rootConfig.oauthAccount)
    return { ClaudeRuntimeAuthService, rootConfigPath, store }
  }

  it('clears rather than guesses when Orca materialized its identity into the legacy source', async () => {
    const seeded = await seedLegacyRootSnapshot()
    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await service.prepareForClaudeLaunch()
    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()

    expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })
  })

  it('never restores the managed identity when a nested config appears after a root snapshot', async () => {
    const seeded = await seedLegacyRootSnapshot()
    // Another tool later ran Claude with CLAUDE_CONFIG_DIR=~/.claude and the old resolver
    // then materialized the managed identity there as well.
    writeFileSync(
      join(testState.fakeHomeDir, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: managedOauthAccount })
    )
    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await service.prepareForClaudeLaunch()
    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()

    expect(JSON.parse(readFileSync(seeded.rootConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })
  })

  it('never restores a legacy identity into a newly inherited config directory', async () => {
    const seeded = await seedLegacyRootSnapshot()
    // Keychain mocks are bound to the default directory; this history is platform-independent.
    setPlatform('linux')
    const overrideDir = join(testState.fakeHomeDir, 'other-claude')
    const overrideConfigPath = join(overrideDir, '.claude.json')
    const overrideConfig = {
      oauthAccount: { accountUuid: 'override-account', emailAddress: 'override@example.com' },
      hasCompletedOnboarding: true
    }
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(overrideConfigPath, JSON.stringify(overrideConfig))
    process.env.CLAUDE_CONFIG_DIR = overrideDir

    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await service.prepareForClaudeLaunch()
    expect(JSON.parse(readFileSync(overrideConfigPath, 'utf-8')).oauthAccount).toEqual(
      managedOauthAccount
    )
    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()

    expect(JSON.parse(readFileSync(overrideConfigPath, 'utf-8'))).toEqual({
      hasCompletedOnboarding: true
    })
  })

  it.each([false, true])(
    'never recaptures an earlier managed identity after a config-path round trip (unreadable managed storage: %s)',
    async (unreadableManagedStorage) => {
      const rootConfigPath = join(testState.fakeHomeDir, '.claude.json')
      const defaultConfigDir = join(testState.fakeHomeDir, '.claude')
      const credentialsPath = join(defaultConfigDir, '.credentials.json')
      const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
      const secondOauthAccount = { accountUuid: 'account-2', emailAddress: 'second@example.com' }
      const firstAuthPath = createManagedClaudeAuth(
        testState.userDataDir,
        'account-1',
        createClaudeCredentialsJson('user@example.com', 'managed'),
        JSON.stringify(managedOauthAccount)
      )
      const secondAuthPath = createManagedClaudeAuth(
        testState.userDataDir,
        'account-2',
        createClaudeCredentialsJson('second@example.com', 'second'),
        JSON.stringify(secondOauthAccount)
      )
      writeFileSync(
        rootConfigPath,
        JSON.stringify({
          oauthAccount: { accountUuid: 'system-account', emailAddress: 'system@example.com' },
          hasCompletedOnboarding: true
        })
      )
      writeFileSync(credentialsPath, systemCredentials)
      testState.scopedKeychainCredentials = systemCredentials
      testState.legacyKeychainCredentials = systemCredentials
      const store = createStore(
        createSettings({
          claudeManagedAccounts: [
            createClaudeAccount('account-1', firstAuthPath),
            createClaudeAccount('account-2', secondAuthPath, { email: 'second@example.com' })
          ],
          activeClaudeManagedAccountId: null
        })
      )
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      const first = new ClaudeRuntimeAuthService(store as never)
      await first.syncForCurrentSelection()
      store.updateSettings({ activeClaudeManagedAccountId: 'account-1' })
      await first.prepareForClaudeLaunch()

      process.env.CLAUDE_CONFIG_DIR = defaultConfigDir
      const second = new ClaudeRuntimeAuthService(store as never)
      store.updateSettings({ activeClaudeManagedAccountId: 'account-2' })
      await second.prepareForClaudeLaunch()

      delete process.env.CLAUDE_CONFIG_DIR
      if (unreadableManagedStorage) {
        writeFileSync(join(firstAuthPath, 'oauth-account.json'), 'not json')
      }
      const third = new ClaudeRuntimeAuthService(store as never)
      store.updateSettings({ activeClaudeManagedAccountId: null })
      await third.syncForCurrentSelection()

      expect(readFileSync(credentialsPath, 'utf-8')).toBe(systemCredentials)
      // Why: account-1 metadata left in ~/.claude.json is Orca's, not system state.
      expect(JSON.parse(readFileSync(rootConfigPath, 'utf-8'))).toEqual({
        hasCompletedOnboarding: true
      })
    }
  )

  it('reconciles native accounts without probing unrelated WSL accounts', async () => {
    const seeded = await seedLegacyRootSnapshot()
    setPlatform('win32')
    runWslProcess.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true })
    const wslAccount = createClaudeAccount(
      'wsl-account',
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\wsl-account\\auth',
      { email: 'wsl@example.com', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }
    )
    const settings = seeded.store.getSettings()
    seeded.store.updateSettings({
      claudeManagedAccounts: [wslAccount, ...settings.claudeManagedAccounts]
    })

    const service = new seeded.ClaudeRuntimeAuthService(seeded.store as never)
    await expect(service.prepareForClaudeLaunch()).resolves.toBeDefined()
    seeded.store.updateSettings({ activeClaudeManagedAccountId: null })
    await expect(service.forceMaterializeCurrentSelectionForRollback()).resolves.toBeUndefined()
  })
})
