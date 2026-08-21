import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setShellStartupEnvProbeSupportedForTest,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState,
  writePaneRegistry
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

  it('returns the Orca-managed runtime home for Codex launch and rate-limit preparation', async () => {
    const markerPath = join(
      testState.userDataDir,
      'codex-session-backfill',
      'backfill-complete.json'
    )
    mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
    writeFileSync(markerPath, '{}\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(markerPath)).toBe(false)
    service.finishHostSystemDefaultSessionMigrationPass()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    service.finishHostSystemDefaultSessionMigrationPass()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    service.prepareForCodexLaunch()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )
    expect(existsSync(markerPath)).toBe(false)
    service.prepareForCodexLaunch()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(null)).toBeNull()
    service.finishHostSystemDefaultSessionMigrationPass()
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: join(getSystemCodexHomePath(), 'sessions'),
        summary: { scannedFiles: 1 }
      })}\n`,
      'utf-8'
    )
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(null, { reattached: true })).toBe(
      false
    )
    expect(existsSync(markerPath)).toBe(false)
    store.updateSettings({
      codexSessionSourceHome: { host: join(testState.fakeHomeDir, 'moved-history'), wsl: {} }
    })
    service.prepareForCodexLaunch()
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getRuntimeCodexHomePath()
    })
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([getRuntimeCodexHomePath()])
    expect(existsSync(getRuntimeCodexHomePath())).toBe(true)
  })

  it('routes host system default to the real home', async () => {
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.isHostSystemDefaultRealHome()).toBe(true)
    expect(service.getSelectedHostCodexHomeRoute()).toBe('real-home')
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([
      getRuntimeCodexHomePath(),
      getSystemCodexHomePath()
    ])
    service.setRealHomeLaneGate(() => false)
    expect(service.getSelectedHostCodexHomeRoute()).toBe('shared-home')
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([getRuntimeCodexHomePath()])
    const markerPath = join(
      testState.userDataDir,
      'codex-session-backfill',
      'backfill-complete.json'
    )
    mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
    writeFileSync(markerPath, '{}\n', 'utf-8')
    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(markerPath)).toBe(false)
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      true
    )
    service.finishHostSystemDefaultSessionMigrationPass()
    service.setRealHomeLaneGate(() => true)
    const perSpawnCustomHome = join(testState.fakeHomeDir, 'per-spawn-custom-codex-home')
    writeFileSync(markerPath, '{}\n', 'utf-8')
    expect(service.isHostSystemDefaultRealHome({ CODEX_HOME: perSpawnCustomHome })).toBe(false)
    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: perSpawnCustomHome })).toBe(
      getRuntimeCodexHomePath()
    )
    expect(existsSync(markerPath)).toBe(true)
    expect(
      service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath(), {
        launchEnv: { CODEX_HOME: perSpawnCustomHome }
      })
    ).toBeNull()
    if (process.platform !== 'win32') {
      // Why: shell startup CODEX_HOME discovery is a POSIX-shell lane; Windows
      // must not invoke an ambient WSL bash while evaluating this contract.
      writeFileSync(
        join(testState.fakeHomeDir, '.zshrc'),
        'export CODEX_HOME="$HOME/shell-custom-codex-home"\n',
        'utf-8'
      )
      const shellLaunchEnv = { HOME: testState.fakeHomeDir, SHELL: '/bin/zsh' }
      expect(service.isHostSystemDefaultRealHome(shellLaunchEnv)).toBe(false)
      expect(service.prepareForCodexLaunch(undefined, shellLaunchEnv)).toBe(
        getRuntimeCodexHomePath()
      )
    }
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    process.env.CODEX_HOME = getRuntimeCodexHomePath()
    process.env.ORCA_CODEX_HOME = getRuntimeCodexHomePath()
    try {
      // Background fetchers prefer ambient CODEX_HOME when passed null, so an
      // explicit path proves nested Orca launches cannot poll the managed home.
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })
      process.env.CODEX_HOME = getSystemCodexHomePath()
      delete process.env.ORCA_CODEX_HOME
      expect(service.isHostSystemDefaultRealHome()).toBe(true)
      process.env.CODEX_HOME = join(testState.fakeHomeDir, 'user-owned-codex-home')
      expect(service.isHostSystemDefaultRealHome()).toBe(false)
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getRuntimeCodexHomePath()
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }
  })

  it('seeds shared auth for a pane-local custom home on the real-home lane', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const customHome = join(testState.fakeHomeDir, 'pane-custom-codex-home')

    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: customHome })).toBe(
      getRuntimeCodexHomePath()
    )
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('skips retired-home reconciliation when no retained host pane can use it', async () => {
    const syncLegacySharedCodexConfigForRetainedPanes = vi.fn()
    vi.doMock('./legacy-shared-config-compatibility', () => ({
      syncLegacySharedCodexConfigForRetainedPanes
    }))
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained')
    const currentAuth = createCodexAuthJson('system@example.com', 'acct-system', 'current')
    const retainedConfig = 'model = "retained"\n'
    writePaneRegistry({
      'real-home-pane': {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home'
      }
    })
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), retainedConfig, 'utf-8')
    writeFileSync(getSystemCodexAuthPath(), currentAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "current"\n', 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'system-default', authJson: retainedAuth })}\n`,
      'utf-8'
    )
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      service.reconcileLegacySharedHomeForRetainedPanes()
      expect(service.prepareForCodexLaunch()).toBeNull()
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })

      expect(syncLegacySharedCodexConfigForRetainedPanes).not.toHaveBeenCalled()
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
      expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
        retainedConfig
      )
    } finally {
      vi.doUnmock('./legacy-shared-config-compatibility')
    }
  })

  it('resolves only Orca-owned homes used by live retained host shells', async () => {
    const accountHome = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    )
    const unownedHome = join(testState.fakeHomeDir, 'unowned-codex-home')
    mkdirSync(unownedHome, { recursive: true })
    writeFileSync(join(unownedHome, '.orca-managed-home'), 'account-2\n', 'utf-8')
    writePaneRegistry({
      'shared-pane': { selectionKey: 'host', accountId: null, homeRoute: 'shared-home' },
      'account-pane': { selectionKey: 'host', accountId: 'account-1', homeRoute: 'account-home' },
      'unowned-pane': { selectionKey: 'host', accountId: 'account-2', homeRoute: 'account-home' },
      'real-pane': { selectionKey: 'host', accountId: null, homeRoute: 'real-home' },
      'wsl-pane': { selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'wsl-home' }
    })
    const settings = createSettings({
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'managed@example.com', 'acct-managed', accountHome),
        createCodexAccountRecord('account-2', 'other@example.com', 'acct-other', unownedHome)
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(
      service.getRetainedHostCodexHookHomePaths([
        'shared-pane',
        'account-pane',
        'unowned-pane',
        'real-pane',
        'wsl-pane',
        'unknown-pane'
      ])
    ).toEqual([getRuntimeCodexHomePath(), accountHome])
  })

  it('keeps pre-rollout shared-home panes authenticated on the real-home lane', async () => {
    const oldSystemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-system')
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(getSystemCodexAuthPath(), oldSystemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(
      join(getRuntimeCodexHomePath(), 'config.toml'),
      'model_provider = "stale-provider"\n',
      'utf-8'
    )

    const service = new CodexRuntimeHomeService(store as never)

    service.setRealHomeLaneGate(() => true)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      'stale-provider'
    )
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(service.prepareForCodexLaunch()).toBeNull()
  })

  it('preserves retained managed auth across a real-home main-process restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.setRealHomeLaneGate(() => true)

    expect(restartedService.prepareForCodexLaunch()).toBeNull()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })
})
