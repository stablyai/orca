import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

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
