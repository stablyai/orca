import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
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
} from '../runtime-home-service-test-harness'

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

  it('does not overwrite auth.json when no managed account was ever active', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"original"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, '{"account":"external-switch"}\n', 'utf-8')
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"external-switch"}\n')
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

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
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

  // A managed account's provenance stays after switching back to the system default.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
    { provenance: 'system default', managed: false },
    { provenance: 'a managed account', managed: true }
  ])(
    'records no logout while ~/.codex/auth.json cannot be read ($provenance)',
    async ({ managed }) => {
      const runtimeAuthPath = getRuntimeCodexAuthPath()
      const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-old')
      const refreshedAuth = createCodexAuthJson(
        'system@example.com',
        'acct-system',
        'system-refreshed'
      )
      writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
      const store = createStore(createSettings())
      const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
      if (managed) {
        writeFileSync(
          getSharedRuntimeAuthProvenancePath(),
          `${JSON.stringify({ owner: 'managed', accountId: 'account-1' })}\n`,
          'utf-8'
        )
      }

      const snapshotBefore = readFileSync(
        join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'),
        'utf-8'
      )
      const systemHome = join(testState.fakeHomeDir, '.codex')
      chmodSync(systemHome, 0o000)
      try {
        service.syncForCurrentSelection()
      } finally {
        chmodSync(systemHome, 0o755)
      }

      // A managed login still leaves the system default's mirror, but no empty snapshot is taken.
      const snapshotPath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'system-default-auth.json'
      )
      if (managed) {
        expect(existsSync(runtimeAuthPath)).toBe(false)
        expect(readFileSync(snapshotPath, 'utf-8')).toBe(snapshotBefore)
      } else {
        expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
      }
      expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    }
  )

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

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
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

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
    rmSync(getSharedRuntimeAuthProvenancePath())
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('keeps runtime logout across restart until System default signs in again', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const logoutMarkerPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-runtime-logout.json'
    )
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()
    new CodexRuntimeHomeService(store as never)
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(existsSync(logoutMarkerPath)).toBe(true)

    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-new"}\n', 'utf-8')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-new"}\n')
    expect(existsSync(logoutMarkerPath)).toBe(false)
  })

  it('clears mirrored runtime auth after restart when the system-default auth was deleted', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const settings = createSettings()
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath(), { force: true })
    const restartedService = new CodexRuntimeHomeService(store as never)
    restartedService.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  // Creating symlinks on Windows needs Developer Mode or admin rights.
  it.each(
    [
      { logout: 'auth.json removed', linked: false },
      { logout: "the linked auth.json's target removed", linked: true }
    ].filter(({ linked }) => !linked || process.platform !== 'win32')
  )(
    'clears refreshed runtime auth after an external system-default logout: $logout',
    async ({ linked }) => {
      const runtimeAuthPath = getRuntimeCodexAuthPath()
      const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
      const refreshedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'refreshed')
      const credential = join(testState.fakeHomeDir, 'credential.json')
      if (linked) {
        writeFileSync(credential, systemAuth, 'utf-8')
        symlinkSync(credential, getSystemCodexAuthPath())
      } else {
        writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
      }
      const store = createStore(createSettings())

      const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
      rmSync(linked ? credential : getSystemCodexAuthPath(), { force: true })
      service.syncForCurrentSelection()

      expect(existsSync(runtimeAuthPath)).toBe(false)
      expect(
        existsSync(
          join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
        )
      ).toBe(true)
    }
  )

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

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
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

  it('tightens auth.json permissions when unchanged content is already present', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    chmodSync(runtimeAuthPath, 0o644)
    service.syncForCurrentSelection()

    expect(statSync(runtimeAuthPath).mode & 0o777).toBe(0o600)
  })
})
