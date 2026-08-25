import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  expectResourceLinkedOrCopied,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
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

  it('routes a host MANAGED account to its own self-contained home', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A host managed account's own home is its CODEX_HOME.
    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.isHostSystemDefaultSessionMigrationEligible()).toBe(false)
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)
    expect(
      service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())
    ).toBeNull()
    // The per-account home keeps its own auth in place; the shared mirror's
    // auth.json is never hot-swapped, so two accounts cannot race one file.
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(
      '{"account":"managed"}\n'
    )
    expect(existsSync(runtimeAuthPath)).toBe(false)
    // Session discovery includes the per-account home so its rollouts surface.
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toContain(managedHomePath)
  })

  it('gives two managed accounts distinct homes without racing one auth.json', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one')
    const account2Auth = createCodexAuthJson('two@example.com', 'acct-2', 'two')
    const home1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const home2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: home1,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: home2,
          providerAccountId: 'acct-2',
          workspaceLabel: null,
          workspaceAccountId: 'acct-2',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // A pane for account-1 launches, then the user switches and a second pane
    // for account-2 launches concurrently — each gets its OWN CODEX_HOME.
    expect(service.prepareForCodexLaunch()).toBe(home1)
    settings.activeCodexManagedAccountId = 'account-2'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-2', wsl: {} }
    expect(service.prepareForCodexLaunch()).toBe(home2)
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: home1
      })
    ).toBe(home2)
    expect(store.updateSettings).not.toHaveBeenCalled()

    // Nothing is hot-swapped, so the still-running account-1 pane keeps seeing
    // account-1's credentials — the single-auth.json race (GAP-5) is gone.
    expect(readFileSync(join(home1, 'auth.json'), 'utf-8')).toBe(account1Auth)
    expect(readFileSync(join(home2, 'auth.json'), 'utf-8')).toBe(account2Auth)
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })

  it('materializes resources and config into the per-account home on launch', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    mkdirSync(join(getSystemCodexHomePath(), 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(getSystemCodexHomePath(), 'skills', 'review', 'SKILL.md'),
      'skill\n',
      'utf-8'
    )
    writeFileSync(
      join(getSystemCodexHomePath(), 'config.toml'),
      'approval_policy = "never"\n',
      'utf-8'
    )
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(home1)
    // Resources link/copy into THIS home; config mirrors into it.
    expectResourceLinkedOrCopied(join(home1, 'skills'), join(getSystemCodexHomePath(), 'skills'))
    expect(readFileSync(join(home1, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expect(readFileSync(join(home1, 'config.toml'), 'utf-8')).toContain('approval_policy = "never"')
    // ~/.codex is never mutated: no auth churn, no per-account dir written back.
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('points the rate-limit fetch at the per-account home', async () => {
    const home1 = createManagedAuth(testState.userDataDir, 'account-1', '{"account":"managed"}\n')
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForRateLimitFetch()).toEqual({ kind: 'ready', codexHomePath: home1 })
  })

  it('preserves a managed selection whose auth.json is temporarily missing', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    // A managed home that has lost its auth.json (only the marker remains).
    const brokenHome = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(brokenHome, { recursive: true })
    writeFileSync(join(brokenHome, '.orca-managed-home'), 'account-1\n', 'utf-8')
    const settings = createSettings({
      shellStartupEnvProbeSupported: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: brokenHome,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
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

    expect(service.prepareForCodexLaunch()).toBe(brokenHome)
    expect(service.prepareForRateLimitFetch()).toEqual({ kind: 'ready', codexHomePath: brokenHome })
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  it('keeps pre-E shared-mirror sessions discoverable alongside per-account rollouts', async () => {
    // Pre-E history lives in the shared runtime mirror; after upgrading to
    // per-account homes, new rollouts land in the account's own home.
    const sharedSessionsDir = join(getRuntimeCodexHomePath(), 'sessions', '2026', '07', '16')
    mkdirSync(sharedSessionsDir, { recursive: true })
    writeFileSync(join(sharedSessionsDir, 'rollout-pre-e.jsonl'), '{"record":"pre-e"}\n', 'utf-8')
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const perAccountSessionsDir = join(home1, 'sessions', '2026', '07', '17')
    mkdirSync(perAccountSessionsDir, { recursive: true })
    writeFileSync(
      join(perAccountSessionsDir, 'rollout-e-era.jsonl'),
      '{"record":"e-era"}\n',
      'utf-8'
    )
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Migrating to per-account homes must not strand the pre-E shared-mirror
    // history: both roots surface in discovery so no session is lost.
    const discovery = service.getHostCodexHomePathsForSessionDiscovery()
    expect(discovery).toContain(getRuntimeCodexHomePath())
    expect(discovery).toContain(home1)
  })

  it('surfaces per-account rollouts for session discovery on the mirror lane', async () => {
    // A Windows host keeps the shared system-default mirror, but its managed
    // accounts still launch from their own homes and accumulate rollouts there.
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const rolloutDir = join(home1, 'sessions', '2026', '07', '17')
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(join(rolloutDir, 'rollout-e-era.jsonl'), '{"record":"e-era"}\n', 'utf-8')
    const store = createStore(
      createSettings({
        shellStartupEnvProbeSupported: false,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // The mirror lane must not hide rollouts living in the per-account home.
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toContain(home1)
  })

  it('keeps per-account auth canonical when the real-home lane takes over', async () => {
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

    // Launching the account from its own home never populates the
    // legacy shared mirror.
    expect(service.isHostSystemDefaultRealHome()).toBe(false)
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)

    // A stale pre-E process writes matching, newer bytes to the shared mirror.
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')

    // Selection drops to the system default WITHOUT an explicit select (no
    // syncForCurrentSelection), then Codex launches on the real home.
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    expect(service.isHostSystemDefaultRealHome()).toBe(true)
    expect(service.prepareForCodexLaunch()).toBeNull()

    // E owns refreshes in place, so takeover ignores later shared-mirror bytes.
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedManagedAuth)
  })

  it('does not read shared auth when polling observes a managed-to-real-home transition', async () => {
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
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(syncSpy).not.toHaveBeenCalled()

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
  })
})
