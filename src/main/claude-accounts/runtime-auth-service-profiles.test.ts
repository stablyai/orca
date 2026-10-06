import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type * as os from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  testState
} from './runtime-auth-service-test-harness'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof os>('node:os')),
  homedir: () => testState.fakeHomeDir
}))

describe('profile-bound Claude preparation', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })
  afterEach(async () => {
    const { markClaudePtyExited } = await import('./live-pty-gate')
    markClaudePtyExited('legacy-test')
    cleanupRuntimeAuthTestState()
  })

  it('prepares two accounts without changing selection or writing the system home', async () => {
    const paths = ['a', 'b'].map((id) =>
      createManagedClaudeAuth(
        testState.userDataDir,
        id,
        createClaudeCredentialsJson(`${id}@example.com`, id)
      )
    )
    const settings = createSettings({
      claudeManagedAccounts: paths.map((path, index) =>
        createClaudeAccount(index === 0 ? 'a' : 'b', path)
      ),
      activeClaudeManagedAccountId: null
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store)
    const a = await service.prepareForClaudeProfileLaunch('a')
    const { markClaudePtySpawned } = await import('./live-pty-gate')
    markClaudePtySpawned('legacy-test', a.isolatedCredentials)
    const b = await service.prepareForClaudeProfileLaunch('b')
    expect(a.envPatch.CLAUDE_CONFIG_DIR).toBe(paths[0])
    expect(b.envPatch.CLAUDE_CONFIG_DIR).toBe(paths[1])
    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
    expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
    expect(readFileSync(join(paths[0], '.credentials.json'), 'utf8')).toContain('a@example.com')
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    expect((await service.prepareForRateLimitFetch()).managedRefreshDeferredByLivePty).toBe(true)
  })

  it('keeps enrolled connector grants local when switching back to the shared account lane', async () => {
    const credentials = createClaudeCredentialsJson('a@example.com', 'a')
    const path = createManagedClaudeAuth(testState.userDataDir, 'a', credentials)
    const settings = createSettings({ claudeManagedAccounts: [createClaudeAccount('a', path)] })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store)
    await service.prepareForClaudeProfileLaunch('a')
    const own = JSON.stringify({ ...JSON.parse(credentials), mcpOAuth: { own: 'grant' } })
    writeFileSync(join(path, '.credentials.json'), own)
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    await service.syncForCurrentSelection()
    store.updateSettings({ activeClaudeManagedAccountId: null })
    await service.syncForCurrentSelection()
    expect(readFileSync(join(path, '.credentials.json'), 'utf8')).toBe(own)
    const shared = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    expect(existsSync(shared) ? readFileSync(shared, 'utf8') : '').not.toContain('grant')
  })

  it('refuses a deleted account instead of using the selected account', async () => {
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(createStore(createSettings()))
    await expect(service.prepareForClaudeProfileLaunch('deleted')).rejects.toThrow(
      'no longer exists'
    )
  })

  it('advances the legacy resume boundary for each account withdrawn from shared auth', async () => {
    const accounts = ['a', 'b'].map((id) =>
      createClaudeAccount(
        id,
        createManagedClaudeAuth(
          testState.userDataDir,
          id,
          createClaudeCredentialsJson(`${id}@example.com`, id)
        )
      )
    )
    const store = createStore(
      createSettings({ claudeManagedAccounts: accounts, activeClaudeManagedAccountId: 'a' })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      await service.prepareForClaudeLaunch()
      await service.prepareForClaudeProfileLaunch('a')
      expect(store.getSettings().claudeProfileMigrationAt).toBe(1000)
      store.updateSettings({ activeClaudeManagedAccountId: 'b' })
      await service.prepareForClaudeLaunch()
      now.mockReturnValue(2000)
      await service.prepareForClaudeProfileLaunch('b')
      expect(store.getSettings().claudeProfileMigrationAt).toBe(2000)
    } finally {
      now.mockRestore()
    }
  })

  it('does not enroll a legacy account while a CLI may own its refresh token', async () => {
    const path = createManagedClaudeAuth(
      testState.userDataDir,
      'a',
      createClaudeCredentialsJson('a@example.com', 'a')
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(
      createStore(createSettings({ claudeManagedAccounts: [createClaudeAccount('a', path)] }))
    )
    const { markClaudePtySpawned } = await import('./live-pty-gate')
    markClaudePtySpawned('legacy-test')
    await expect(service.prepareForClaudeProfileLaunch('a')).rejects.toThrow('Close')
    expect(existsSync(join(path, '.orca-claude-isolated-auth'))).toBe(false)
  })
})
