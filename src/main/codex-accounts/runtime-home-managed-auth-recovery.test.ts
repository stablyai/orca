import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('preserves selected identity when per-account auth disappears before launch', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one', 1)
    const account1Refreshed = createCodexAuthJson('one@example.com', 'acct-1', 'one-refreshed', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'wsl-account',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'wsl')
    )
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A stale pre-E process leaves a matching refresh in the shared runtime home.
    writeFileSync(runtimeAuthPath, account1Refreshed, 'utf-8')

    // The active account's canonical auth disappears before launch.
    rmSync(join(managedHomePath1, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)

    // Missing canonical auth preserves selection without reviving shared bytes.
    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1Refreshed)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: managedHomePath1
    })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)
    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)

    writeFileSync(join(managedHomePath1, 'auth.json'), account1Auth, 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    rmSync(join(managedHomePath1, 'auth.json'), { force: true })
    // Why: the first missing read may be a rotation in flight — the selection
    // survives the grace window and the launch still targets the account home.
    const absenceObservedAt = Date.now()
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Once the absence outlives the grace window it is durable and deselects.
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => absenceObservedAt + 6_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath1
        })
      ).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: null,
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(store.getSettings().codexManagedAccounts).toHaveLength(2)
    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('does not deselect the account when a transient unreadable auth.json heals', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const accountAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', accountAuth)
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: 'acct-user',
            workspaceLabel: null,
            workspaceAccountId: 'acct-user',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A mid-write read observes torn JSON: no deselect, and the launch still
    // targets the account home so codex re-reads the settled file itself.
    writeFileSync(join(managedHomePath, 'auth.json'), '{"tokens":{"acc', 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath
      })
    ).toBe(managedHomePath)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()

    // The write completes; even past the grace window the selection is intact.
    writeFileSync(join(managedHomePath, 'auth.json'), accountAuth, 'utf-8')
    const healedAt = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => healedAt + 60_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath
        })
      ).toBe(managedHomePath)
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('ignores mismatched runtime auth when the active managed auth is missing', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const mismatchedAuth = createCodexAuthJson('other@example.com', 'acct-other', 'other', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, mismatchedAuth, 'utf-8')
    rmSync(join(managedHomePath, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)

    expect(existsSync(join(managedHomePath, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(mismatchedAuth)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('ignores shared auth on an explicit managed-to-real-home deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A stale pre-E process writes matching bytes, then the normal selection
    // path deselects the self-contained account.
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)

    // A subsequent real-home launch also leaves both stores untouched.
    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
  })
})
