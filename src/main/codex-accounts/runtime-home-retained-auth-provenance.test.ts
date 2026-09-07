import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
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

  it('fences retained shared auth when a self-contained managed transition begins', async () => {
    const systemAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'system')
    const managedAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'shared@example.com',
          managedHomePath,
          providerAccountId: 'acct-shared',
          workspaceLabel: null,
          workspaceAccountId: 'acct-shared',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    rmSync(getSystemCodexAuthPath())

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
  })

  it('restores retained system ownership when a self-contained transition leaves it untouched', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed'
    )
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'managed@example.com',
          managedHomePath,
          providerAccountId: 'acct-managed',
          workspaceLabel: null,
          workspaceAccountId: 'acct-managed',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('restores authoritative system auth when the shared lane follows a managed transition', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'managed@example.com',
          managedHomePath,
          providerAccountId: 'acct-managed',
          workspaceLabel: null,
          workspaceAccountId: 'acct-managed',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    setShellStartupEnvProbeSupportedForTest(false)
    service.syncForCurrentSelection()

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('refreshes untouched retained-pane auth during real-home rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('does not rewrite retained-auth provenance during unchanged rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const provenancePath = getSharedRuntimeAuthProvenancePath()
    const originalInode = statSync(provenancePath).ino

    setShellStartupEnvProbeSupportedForTest(true)
    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()

    expect(statSync(provenancePath).ino).toBe(originalInode)
  })

  it('does not rewrite completed retained logout metadata during rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    service.prepareForRateLimitFetch()
    const metadataPaths = [
      getSharedRuntimeAuthProvenancePath(),
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
    ]
    const originalInodes = metadataPaths.map((path) => statSync(path).ino)

    service.prepareForRateLimitFetch()
    service.prepareForRateLimitFetch()

    expect(metadataPaths.map((path) => statSync(path).ino)).toEqual(originalInodes)
  })

  it('clears managed transition state before later retained-auth reconciliation', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed-token')
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'managed@example.com',
          managedHomePath,
          providerAccountId: 'acct-managed',
          workspaceLabel: null,
          workspaceAccountId: 'acct-managed',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    service.syncForCurrentSelection()

    writeFileSync(getRuntimeCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'shared-runtime-auth-provenance.json'),
      `${JSON.stringify({ owner: 'system-default', authJson: systemAuth })}\n`
    )
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    setShellStartupEnvProbeSupportedForTest(true)
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('does not overwrite auth changed by a retained Codex process', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('applies source logout after a retained pane refreshes the same identity', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    rmSync(getSystemCodexAuthPath())

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })

  it('repairs a completed pending system-auth replacement after restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({
        owner: 'pending',
        next: { owner: 'system-default', authJson: systemAuth },
        runtimeAuthJson: systemAuth
      })}\n`
    )

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(refreshedSystemAuth)
  })

  it('recovers runtime auth quarantined by an interrupted guarded update', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const heldAuthPath = `${runtimeAuthPath}.orca-guarded`
    renameSync(runtimeAuthPath, heldAuthPath)

    setShellStartupEnvProbeSupportedForTest(true)
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
    expect(existsSync(heldAuthPath)).toBe(false)
  })

  it('fences a pending auth replacement when runtime bytes do not match its intent', async () => {
    const systemAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'system')
    const retainedAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'retained')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({
        owner: 'pending',
        next: { owner: 'system-default', authJson: systemAuth },
        runtimeAuthJson: systemAuth
      })}\n`
    )
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
  })

  it('does not treat malformed provenance as a missing migration marker', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getSharedRuntimeAuthProvenancePath(), '{"owner":"pending"}\n')

    setShellStartupEnvProbeSupportedForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('recreates proven logged-out shared auth after a real-home re-login', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    const service = new CodexRuntimeHomeService(store as never)
    rmSync(getSystemCodexAuthPath())
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)

    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it.each([
    ['committed provenance', false],
    ['pre-provenance migration', true]
  ])(
    'recreates retained auth after a %s crash between logout deletion and metadata commit',
    async (_label, removeProvenance) => {
      const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
      const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
      writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
      const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      new CodexRuntimeHomeService(store as never)

      setShellStartupEnvProbeSupportedForTest(true)
      rmSync(getSystemCodexAuthPath())
      rmSync(getRuntimeCodexAuthPath())
      if (removeProvenance) {
        rmSync(getSharedRuntimeAuthProvenancePath())
      }
      rmSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json'),
        {
          force: true
        }
      )
      const restartedService = new CodexRuntimeHomeService(store as never)
      restartedService.setRealHomeLaneGate(() => true)

      expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
      writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
      expect(restartedService.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
    }
  )

  it('recreates retained auth after interrupted logout crosses a managed transition', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed-token')
    )
    const settings = createSettings({
      shellStartupEnvProbeSupported: false,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'managed@example.com',
          managedHomePath,
          providerAccountId: 'acct-managed',
          workspaceLabel: null,
          workspaceAccountId: 'acct-managed',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setShellStartupEnvProbeSupportedForTest(true)
    rmSync(getSystemCodexAuthPath())
    rmSync(getRuntimeCodexAuthPath())
    rmSync(
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json'),
      {
        force: true
      }
    )
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.setRealHomeLaneGate(() => true)
    restartedService.reconcileLegacySharedHomeForRetainedPanes()

    settings.activeCodexManagedAccountId = 'account-1'
    settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-1', wsl: {} }
    restartedService.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    restartedService.syncForCurrentSelection()

    restartedService.prepareForRateLimitFetch()
    restartedService.prepareForRateLimitFetch()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it('preserves shared config changes when a pending real-home lane falls back', async () => {
    const systemConfigPath = join(getSystemCodexHomePath(), 'config.toml')
    const runtimeConfigPath = join(getRuntimeCodexHomePath(), 'config.toml')
    writeFileSync(systemConfigPath, 'model = "baseline"\n', 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    writeFileSync(runtimeConfigPath, 'model = "runtime-change"\n', 'utf-8')

    setShellStartupEnvProbeSupportedForTest(true)
    service.setRealHomeLaneGate(() => false)
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(systemConfigPath, 'utf-8')).toBe('model = "baseline"\n')
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(systemConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "runtime-change"\n')
  })
})
