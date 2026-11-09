import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setRealHomeRoutableForTest,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// Keep asserted config bytes independent of platform socket-path limits.
vi.mock(
  '../codex/configuration/shared-server/codex-daemon-socket-path-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyCodexDaemonSocketGuard: (config: string) => config
  })
)

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
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

    setRealHomeRoutableForTest(true)
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

  it('refreshes untouched retained-pane auth during real-home rate polling', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const refreshedSystemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed-token'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)

    setRealHomeRoutableForTest(true)
    writeFileSync(getSystemCodexAuthPath(), refreshedSystemAuth, 'utf-8')

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
    const store = createStore(createSettings({ realHomeRoutable: true }))
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
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setRealHomeRoutableForTest(true)
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
    const store = createStore(createSettings({ realHomeRoutable: false }))
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

    setRealHomeRoutableForTest(true)
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
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const heldAuthPath = `${runtimeAuthPath}.orca-guarded`
    renameSync(runtimeAuthPath, heldAuthPath)

    setRealHomeRoutableForTest(true)
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
    expect(existsSync(heldAuthPath)).toBe(false)
  })

  it('fences a pending auth replacement when runtime bytes do not match its intent', async () => {
    const systemAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'system')
    const retainedAuth = createCodexAuthJson('shared@example.com', 'acct-shared', 'retained')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
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

    setRealHomeRoutableForTest(true)
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
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(getSharedRuntimeAuthProvenancePath(), '{"owner":"pending"}\n')

    setRealHomeRoutableForTest(true)
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
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    setRealHomeRoutableForTest(true)
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
      const store = createStore(createSettings({ realHomeRoutable: false }))
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      new CodexRuntimeHomeService(store as never)

      setRealHomeRoutableForTest(true)
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

      expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
      writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
      expect(restartedService.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
    }
  )
})
