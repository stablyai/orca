import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

// Why a local mock: the shared harness only models the host's own scoped item, and a pinned
// launch's whole point is a second scoped item keyed by the managed dir.
const keychain = vi.hoisted(() => ({
  scoped: new Map<string, string>(),
  legacy: null as string | null,
  throwScopedRead: false
}))

vi.mock('./keychain', () => ({
  readActiveClaudeKeychainCredentials: vi.fn(async (configDir?: string) =>
    configDir ? (keychain.scoped.get(configDir) ?? keychain.legacy) : keychain.legacy
  ),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
    if (!configDir) {
      return keychain.legacy
    }
    if (keychain.throwScopedRead) {
      throw new Error('keychain locked')
    }
    return keychain.scoped.get(configDir) ?? null
  }),
  writeActiveClaudeKeychainCredentials: vi.fn(async (contents: string, configDir?: string) => {
    if (!configDir) {
      keychain.legacy = contents
      return
    }
    keychain.scoped.set(configDir, contents)
  }),
  writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(
    async (contents: string, configDir: string) => {
      keychain.scoped.set(configDir, contents)
      keychain.legacy = contents
    }
  ),
  deleteActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
    if (!configDir) {
      keychain.legacy = null
      return
    }
    keychain.scoped.delete(configDir)
  }),
  readManagedClaudeKeychainCredentials: vi.fn(
    async (accountId: string) => testState.managedKeychainCredentials.get(accountId) ?? null
  ),
  writeManagedClaudeKeychainCredentials: vi.fn(async (accountId: string, contents: string) => {
    testState.managedKeychainCredentials.set(accountId, contents)
  })
}))

type Fixture = Awaited<ReturnType<typeof setUpTwoAccounts>>

async function setUpTwoAccounts() {
  const activeCredentials = createClaudeCredentialsJson('active@example.com', 'active')
  const pinnedCredentials = createClaudeCredentialsJson('pinned@example.com', 'pinned')
  const activePath = createManagedClaudeAuth(testState.userDataDir, 'acct-a', activeCredentials)
  const pinnedPath = createManagedClaudeAuth(
    testState.userDataDir,
    'acct-b',
    pinnedCredentials,
    `${JSON.stringify({ accountUuid: 'uuid-b', emailAddress: 'pinned@example.com' })}\n`
  )
  const settings = createSettings({
    claudeManagedAccounts: [
      createClaudeAccount('acct-a', activePath, { email: 'active@example.com' }),
      createClaudeAccount('acct-b', pinnedPath, { email: 'pinned@example.com' })
    ],
    activeClaudeManagedAccountId: 'acct-a'
  })
  const store = createStore(settings)
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const registry = await import('./claude-pinned-pty-registry')
  const service = new ClaudeRuntimeAuthService(store as never)
  await service.syncForCurrentSelection()
  return {
    service,
    store,
    registry,
    activeCredentials,
    pinnedCredentials,
    pinnedPath,
    pinnedDir: realpathSync(pinnedPath),
    runtimeCredentialsPath: join(testState.fakeHomeDir, '.claude', '.credentials.json')
  }
}

function markerPath(fixture: Fixture): string {
  return join(fixture.pinnedDir, '.orca-pinned-keychain-seed')
}

describe('ClaudeRuntimeAuthService pinned --account launches', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    resetRuntimeAuthTestState()
    delete process.env.CLAUDE_CONFIG_DIR
    keychain.scoped.clear()
    keychain.legacy = null
    keychain.throwScopedRead = false
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  it.each(['linux', 'win32'] as const)(
    'on %s points Claude at the managed dir without touching the host sync',
    async (platform) => {
      setPlatform(platform)
      const fixture = await setUpTwoAccounts()
      const hostCredentialsBefore = readFileSync(fixture.runtimeCredentialsPath, 'utf-8')
      fixture.store.updateSettings.mockClear()

      const prepared = await fixture.service.prepareForClaudeLaunch(
        { runtime: 'host' },
        { accountId: 'acct-b' }
      )

      expect(prepared).toEqual({
        configDir: fixture.pinnedDir,
        runtime: 'host',
        wslDistro: null,
        wslLinuxConfigDir: null,
        envPatch: {
          CLAUDE_CONFIG_DIR: fixture.pinnedDir,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: fixture.pinnedDir
        },
        stripAuthEnv: true,
        pinnedAccountId: 'acct-b',
        provenance: 'managed:acct-b:pinned'
      })
      expect(readFileSync(fixture.runtimeCredentialsPath, 'utf-8')).toBe(hostCredentialsBefore)
      expect(fixture.store.updateSettings).not.toHaveBeenCalled()
      expect(keychain.scoped.size).toBe(0)
      expect(existsSync(markerPath(fixture))).toBe(false)
      // The spawn owns the reservation from here and releases it once the PTY is registered.
      expect(fixture.registry.countClaudePinnedAccountUsers('acct-b')).toBe(1)
    }
  )

  it('takes the normal launch path when --account names the active host account', async () => {
    setPlatform('linux')
    const fixture = await setUpTwoAccounts()

    const prepared = await fixture.service.prepareForClaudeLaunch(
      { runtime: 'host' },
      { accountId: 'acct-a' }
    )

    expect(prepared.provenance).toBe('managed:acct-a')
    expect(prepared.pinnedAccountId).toBeUndefined()
    expect(prepared.envPatch).toEqual({})
    expect(fixture.registry.countClaudePinnedAccountUsers('acct-a')).toBe(0)
    expect(readFileSync(fixture.runtimeCredentialsPath, 'utf-8')).toBe(fixture.activeCredentials)
  })

  it('refuses WSL targets, unknown accounts, and accounts without a saved sign-in', async () => {
    setPlatform('linux')
    const fixture = await setUpTwoAccounts()

    await expect(
      fixture.service.prepareForClaudeLaunch(
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        { accountId: 'acct-b' }
      )
    ).rejects.toThrow(/not supported for WSL/)
    await expect(
      fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-zzz' })
    ).rejects.toThrow(/no longer exists/)
    writeFileSync(join(fixture.pinnedPath, '.credentials.json'), '{"claudeAiOauth":{}}')
    await expect(
      fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    ).rejects.toThrow(/no valid saved sign-in/)
    expect(fixture.registry.countClaudePinnedAccountUsers('acct-b')).toBe(0)
  })

  it('on macOS seeds only the scoped Keychain item of the managed dir', async () => {
    const fixture = await setUpTwoAccounts()
    const legacyBefore = keychain.legacy
    const hostScopedBefore = keychain.scoped.get(join(testState.fakeHomeDir, '.claude'))

    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })

    expect(keychain.scoped.get(fixture.pinnedDir)).toBe(fixture.pinnedCredentials)
    expect(keychain.legacy).toBe(legacyBefore)
    expect(keychain.scoped.get(join(testState.fakeHomeDir, '.claude'))).toBe(hostScopedBefore)
    const { hashClaudeCredentialsJson, hasPendingPinnedClaudeSeed } =
      await import('./claude-pinned-credentials')
    expect(readFileSync(markerPath(fixture), 'utf-8').trim()).toBe(
      hashClaudeCredentialsJson(fixture.pinnedCredentials)
    )
    // The marker stores a hash, never the credential.
    expect(readFileSync(markerPath(fixture), 'utf-8')).not.toContain('pinned-refresh')
    expect(hasPendingPinnedClaudeSeed('acct-b')).toBe(true)
  })

  it('does not reseed an item a live pinned Claude already refreshed', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry.markPinnedClaudePtySpawned('pty-1', 'acct-b')
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)

    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })

    expect(keychain.scoped.get(fixture.pinnedDir)).toBe(refreshed)
  })

  it('adopts a refreshed Keychain copy into the managed store once the account drains', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)
    fixture.registry.markPinnedClaudePtySpawned('pty-1', 'acct-b')
    fixture.registry._internals.reset()

    await fixture.service.reconcilePinnedAccountCredentials('acct-b')

    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(refreshed)
    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)
    expect(existsSync(markerPath(fixture))).toBe(false)
    // The host account never moved.
    expect(readFileSync(fixture.runtimeCredentialsPath, 'utf-8')).toBe(fixture.activeCredentials)
  })

  it('lets a re-auth that happened during the pinned session win the read-back', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry._internals.reset()
    keychain.scoped.set(
      fixture.pinnedDir,
      createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    )
    const reauthed = createClaudeCredentialsJson('pinned@example.com', 'pinned-reauthed')
    testState.managedKeychainCredentials.set('acct-b', reauthed)

    await fixture.service.reconcilePinnedAccountCredentials('acct-b')

    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(reauthed)
    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)
    expect(existsSync(markerPath(fixture))).toBe(false)
  })

  it('rejects a read-back that proves a different identity', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry._internals.reset()
    keychain.scoped.set(
      fixture.pinnedDir,
      createClaudeCredentialsJson('someone-else@example.com', 'other')
    )

    await fixture.service.reconcilePinnedAccountCredentials('acct-b')

    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(
      fixture.pinnedCredentials
    )
    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)
  })

  it('does not read back while the account still has pinned users', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)

    await fixture.service.reconcilePinnedAccountCredentials('acct-b')

    expect(keychain.scoped.get(fixture.pinnedDir)).toBe(refreshed)
    expect(existsSync(markerPath(fixture))).toBe(true)
  })

  it('recovers a crashed pinned session before the next pinned launch reseeds', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    // A crash: the PTY is gone and no drain ran, so the marker and the refreshed item remain.
    fixture.registry._internals.reset()
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)

    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })

    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(refreshed)
    expect(keychain.scoped.get(fixture.pinnedDir)).toBe(refreshed)
    const { hashClaudeCredentialsJson } = await import('./claude-pinned-credentials')
    expect(readFileSync(markerPath(fixture), 'utf-8').trim()).toBe(
      hashClaudeCredentialsJson(refreshed)
    )
  })

  it('refuses to reseed over an unread Keychain copy it cannot read', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry._internals.reset()
    keychain.throwScopedRead = true

    await expect(
      fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    ).rejects.toThrow(/Unlock the Keychain/)
    expect(existsSync(markerPath(fixture))).toBe(true)
    expect(fixture.registry.countClaudePinnedAccountUsers('acct-b')).toBe(0)
  })

  it('reads a crashed pinned session back before the account becomes the host account', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry._internals.reset()
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)

    fixture.store.updateSettings({ activeClaudeManagedAccountId: 'acct-b' })
    await fixture.service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(refreshed)
    expect(readFileSync(fixture.runtimeCredentialsPath, 'utf-8')).toBe(refreshed)
    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)
  })

  it('refuses a pinned launch while the account is being switched to or removed', async () => {
    const fixture = await setUpTwoAccounts()
    const endMutation = fixture.registry.beginClaudeAccountHostMutation('acct-b')

    await expect(
      fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    ).rejects.toThrow(/being switched to or removed/)

    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)
    expect(fixture.registry.countClaudePinnedAccountUsers('acct-b')).toBe(0)
    endMutation?.()
  })

  it('waits out an in-flight usage fetch before seeding the pinned Keychain item', async () => {
    const fixture = await setUpTwoAccounts()
    const endFetch = fixture.registry.beginClaudeAccountUsageFetch('acct-b')
    let settled = false
    const prepared = fixture.service
      .prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
      .finally(() => {
        settled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(settled).toBe(false)
    expect(keychain.scoped.has(fixture.pinnedDir)).toBe(false)

    endFetch?.()
    await expect(prepared).resolves.toMatchObject({ pinnedAccountId: 'acct-b' })
    expect(keychain.scoped.get(fixture.pinnedDir)).toBe(fixture.pinnedCredentials)
  })

  it('drops startup seed flags it cannot prove and reads back provable ones', async () => {
    const fixture = await setUpTwoAccounts()
    await fixture.service.prepareForClaudeLaunch({ runtime: 'host' }, { accountId: 'acct-b' })
    fixture.registry._internals.reset()
    const credentials = await import('./claude-pinned-credentials')
    const refreshed = createClaudeCredentialsJson('pinned@example.com', 'pinned-rotated')
    keychain.scoped.set(fixture.pinnedDir, refreshed)
    // A flag the raw-path scan set for an account whose dir Orca does not own any more.
    const strayDir = join(testState.userDataDir, 'stray')
    mkdirSync(strayDir, { recursive: true })
    writeFileSync(join(strayDir, '.orca-pinned-keychain-seed'), 'hash\n')
    credentials.notePinnedClaudeSeedMarker('acct-a', strayDir)
    expect(credentials.hasPendingPinnedClaudeSeed('acct-a')).toBe(true)

    await fixture.service.revalidatePinnedSeedMarkers()

    expect(credentials.hasPendingPinnedClaudeSeed('acct-a')).toBe(false)
    expect(credentials.hasPendingPinnedClaudeSeed('acct-b')).toBe(false)
    expect(readManagedCredentialsForTest('acct-b', fixture.pinnedPath)).toBe(refreshed)
    expect(existsSync(markerPath(fixture))).toBe(false)
  })
})
