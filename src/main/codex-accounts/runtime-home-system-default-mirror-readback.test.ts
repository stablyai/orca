import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getSharedRuntimeAuthProvenancePath,
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

  it('does not overwrite auth.json when no managed account was ever active', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"original"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, '{"account":"external-switch"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-switch"}\n')
  })

  it('refreshes the runtime auth when the system-default auth changes later', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-1"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-1"}\n')

    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-2"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-2"}\n')
  })

  it('reads back system-default token refreshes from runtime auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-old')
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-refreshed'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(
      JSON.parse(
        readFileSync(
          join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
          'utf-8'
        )
      )
    ).toEqual({ authJson: refreshedAuth })
  })

  it('reads back system-default token refreshes after a pre-provenance restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-old',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-refreshed',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('does not read back older same-identity auth without provenance', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-newer',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    const staleRuntimeAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'runtime-older',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('keeps a local runtime logout when the system-default auth still exists', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('keeps a local runtime logout after restart when the system-default auth still exists', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    new CodexRuntimeHomeService(store as never)

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(true)
  })

  it('mirrors a fresh external system-default login after a persisted local runtime logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-new"}\n', 'utf-8')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-new"}\n')
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(false)
  })

  it('mirrors a fresh external system-default login after a same-process local runtime logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-new"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-new"}\n')
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(false)
  })

  it('clears the mirrored runtime auth after an external system-default logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath(), { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('clears mirrored runtime auth after restart when the system-default auth was deleted', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath(), { force: true })
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('clears refreshed runtime auth after an external system-default logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'refreshed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSystemCodexAuthPath(), { force: true })
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(
      existsSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
      )
    ).toBe(true)
  })

  it('clears refreshed runtime auth after a pre-provenance external logout', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system',
      undefined,
      '2026-07-30T12:00:00.000Z'
    )
    const refreshedAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'refreshed',
      undefined,
      '2026-07-31T12:00:00.000Z'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    rmSync(getSystemCodexAuthPath())
    new CodexRuntimeHomeService(store as never)

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('persists runtime auth refreshes after returning to system default', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const refreshedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'refreshed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
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
      ]
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    // Deselect managed account — should restore system default once
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)

    // Codex used to refresh tokens directly in ~/.codex. With an Orca-owned
    // runtime home, the same refresh must be read back to the system default.
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    service.syncForCurrentSelection()
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(refreshedAuth)
  })

  it('does not write stale managed runtime auth back to system default', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    const staleManagedRefresh = createCodexAuthJson(
      'managed@example.com',
      'acct-managed',
      'managed-refreshed'
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
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
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    writeFileSync(runtimeAuthPath, staleManagedRefresh, 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('writes auth.json with restrictive permissions', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    const mode = statSync(runtimeAuthPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('tightens auth.json permissions when unchanged content is already present', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    chmodSync(runtimeAuthPath, 0o644)
    service.syncForCurrentSelection()

    expect(statSync(runtimeAuthPath).mode & 0o777).toBe(0o600)
  })

  it('does not throw when syncForCurrentSelection encounters an error', async () => {
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath: '/nonexistent/path/home',
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    expect(() => new CodexRuntimeHomeService(store as never)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })
})
