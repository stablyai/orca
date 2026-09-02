import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

  it('captures the existing ~/.codex auth as the system-default snapshot', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(true)
    if (process.platform !== 'win32') {
      expect(
        statSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
          .mode & 0o777
      ).toBe(0o600)
    }
  })

  it('refuses to read runtime auth back into a duplicate account while a home is unreadable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('system@example.com', 'acct-system', 'system'),
      'utf-8'
    )
    const authX = createCodexAuthJson('x@example.com', 'acct-x', 'x', 1)
    const authXRefreshed = createCodexAuthJson('x@example.com', 'acct-x', 'x-refreshed', 2)
    // Two records for the same identity: one home unreadable, one readable.
    const homeX1 = createManagedAuth(testState.userDataDir, 'account-x1', authX)
    const homeX2 = createManagedAuth(testState.userDataDir, 'account-x2', authX)
    const homeB = createManagedAuth(
      testState.userDataDir,
      'account-b',
      createCodexAuthJson('b@example.com', 'acct-b', 'b')
    )
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(runtimeAuthPath, authXRefreshed, 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'managed', accountId: 'account-x1' })}\n`,
      'utf-8'
    )
    chmodSync(join(homeX1, 'auth.json'), 0o000)
    rmSync(join(homeB, 'auth.json'), { force: true })
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-x1', 'x@example.com', 'acct-x', homeX1),
          createCodexAccountRecord('account-x2', 'x@example.com', 'acct-x', homeX2),
          createCodexAccountRecord('account-b', 'b@example.com', 'acct-b', homeB)
        ],
        activeCodexManagedAccountId: 'account-b',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-b', wsl: {} }
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(homeX2, 'auth.json'), 'utf-8')).toBe(authX)
  })

  it('keeps the mirror of a renamed account whose record email is stale', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('system@example.com', 'acct-system', 'system'),
      'utf-8'
    )
    const renamedAuth = createCodexAuthJson('new@example.com', 'acct-user', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', renamedAuth)
    // Torn provenance can no longer vouch for the mirror, and the only remaining
    // evidence is a credential whose email no longer matches the record.
    mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
    writeFileSync(runtimeAuthPath, renamedAuth, 'utf-8')
    writeFileSync(getSharedRuntimeAuthProvenancePath(), 'not-json', 'utf-8')
    writeFileSync(join(managedHomePath, 'auth.json'), '{"tokens":{"acc', 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'old@example.com', 'acct-user', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(renamedAuth)
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe('account-1')
  })

  it('restores the system-default snapshot when no managed account is selected', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
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
      ],
      activeCodexManagedAccountId: null
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    writeFileSync(runtimeAuthPath, '{"account":"managed"}\n', 'utf-8')

    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('removes runtime auth when deselecting with a missing system-default snapshot', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed')
    writeFileSync(runtimeAuthPath, managedAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('repairs a corrupt system-default snapshot from the live ~/.codex auth on deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()

    const snapshotPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-auth.json'
    )
    writeFileSync(snapshotPath, '{not valid json', 'utf-8')
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
    expect(existsSync(snapshotPath)).toBe(true)
    expect(JSON.parse(readFileSync(snapshotPath, 'utf-8'))).toEqual({
      authJson: '{"account":"system"}\n'
    })
  })

  it('clears an active account selection whose self-contained home is missing', async () => {
    const missingManagedHomePath = join(
      testState.userDataDir,
      'codex-accounts',
      'account-1',
      'home'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: missingManagedHomePath,
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
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(warnSpy).toHaveBeenCalled()
  })

  it('clears an unknown active account id and removes untrusted runtime auth', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"stale-managed"}\n', 'utf-8')
    const settings = createSettings({
      activeCodexManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('clears system-default snapshot via clearSystemDefaultSnapshot', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system"}\n', 'utf-8')
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    const snapshotPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-auth.json'
    )
    expect(existsSync(snapshotPath)).toBe(true)

    service.clearSystemDefaultSnapshot()
    expect(existsSync(snapshotPath)).toBe(false)
  })

  it('reads back verified same-account refreshes on first sync after restart', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const originalAuth = createCodexAuthJson('user@example.com', 'acct-1', 'original', 1_000)
    const refreshedAuth = createCodexAuthJson('user@example.com', 'acct-1', 'refreshed', 2_000)
    writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1'
      })
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
  })

  it('restores system default when unverified runtime auth appears before deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
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

    // A stale or external process overwrites runtime with auth Orca cannot
    // verify against the outgoing managed account.
    writeFileSync(runtimeAuthPath, '{"account":"external-login"}\n', 'utf-8')

    // Deselect managed account
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system"}\n')
    expect(
      existsSync(join(testState.userDataDir, 'codex-runtime-home', 'system-default-auth.json'))
    ).toBe(true)
  })

  it('restores system default when stale Codex credentials are rejected on deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-old"}\n', 'utf-8')
    const selectedAuth = createCodexAuthJson('selected@example.com', 'acct-selected', 'selected')
    const staleLivePtyAuth = createCodexAuthJson('stale@example.com', 'acct-stale', 'stale')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', selectedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'selected@example.com',
          managedHomePath,
          providerAccountId: 'acct-selected',
          workspaceLabel: null,
          workspaceAccountId: 'acct-selected',
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

    writeFileSync(runtimeAuthPath, staleLivePtyAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(managedAuthPath, 'utf-8')).toBe(selectedAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-old"}\n')
  })

  it('keeps external Codex logout when deselecting managed account', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"system-old"}\n', 'utf-8')
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(runtimeAuthPath, { force: true })
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('recreates retained auth after a logged-out system default logs back in', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-token')
    const reloginAuth = createCodexAuthJson('system@example.com', 'acct-system', 'relogin-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    rmSync(getSystemCodexAuthPath())
    service.syncForCurrentSelection()
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)

    setShellStartupEnvProbeSupportedForTest(true)
    service.setRealHomeLaneGate(() => true)
    writeFileSync(getSystemCodexAuthPath(), reloginAuth, 'utf-8')
    service.reconcileLegacySharedHomeForRetainedPanes()

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(reloginAuth)
  })

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-1"}\n', 'utf-8')
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
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system-2"}\n', 'utf-8')

    settings.activeCodexManagedAccountId = 'account-1'
    service.syncForCurrentSelection()
    settings.activeCodexManagedAccountId = null
    service.syncForCurrentSelection()

    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"system-2"}\n')
  })
})
