import { describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { CodexAccountSelection } from './codex-account-selection'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

function account(id: string, runtime: 'host' | 'wsl' = 'host'): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: createManagedHome(testState.userDataDir, id),
    managedHomeRuntime: runtime,
    wslDistro: runtime === 'wsl' ? 'Ubuntu' : null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function removalFixture(accounts: CodexManagedAccount[], host: string | null) {
  const store = createStore(
    createSettings({
      codexManagedAccounts: accounts,
      activeCodexManagedAccountId: host,
      activeCodexManagedAccountIdsByRuntime: {
        host,
        wsl: {
          Ubuntu: accounts.find((entry) => entry.managedHomeRuntime === 'wsl')?.id ?? null,
          Debian: 'missing-account'
        }
      }
    })
  )
  const runtimeHome = createRuntimeHome()
  const onHostSystemDefaultSelected = vi.fn()
  const removeManagedHome = vi.fn(() => true)
  const selection = new CodexAccountSelection({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements every Store operation used by removal.
    store: store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies quota refresh and cache eviction.
    rateLimits: createRateLimits() as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies synchronous runtime reconciliation.
    runtimeHome: runtimeHome as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Removal does not use the config mirror.
    configMirror: {} as never,
    lifecycle: { onHostSystemDefaultSelected },
    resolveSystemDefault: () => ({
      hasAuth: false,
      authKind: 'none',
      email: null,
      providerAccountId: null,
      workspaceLabel: null
    }),
    removeManagedHome,
    persistAccountRemoval: (_id, updates) =>
      store.updateCodexAccountSettingsAndResetLedgerAndFlush(updates, { version: 1, attempts: [] })
  })
  return { store, runtimeHome, onHostSystemDefaultSelected, removeManagedHome, selection }
}

describe('Codex removal runtime reconciliation', () => {
  registerCodexAccountsTestHomes()

  it('allows the real runtime to clear an untrusted active home while another account is removed', async () => {
    const active = account('active-host')
    rmSync(join(active.managedHomePath, '.orca-managed-home'))
    const { store, runtimeHome, selection, onHostSystemDefaultSelected } = removalFixture(
      [active, account('removed')],
      active.id
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real sync path only reads settings and writes selection through the fixture.
    const realRuntime = new CodexRuntimeHomeService(store as never)
    runtimeHome.syncForCurrentSelection.mockImplementation((target) =>
      realRuntime.syncForCurrentSelection(target)
    )
    expect((await selection.remove('removed')).activeAccountId).toBeNull()
    expect(store.getSettings().codexManagedAccounts).toEqual([active])
    expect(onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })

  it('commits a runtime self-heal and runs the host lifecycle after removing a WSL account', async () => {
    const fixture = removalFixture(
      [account('active-host'), account('removed', 'wsl')],
      'active-host'
    )
    const { store, runtimeHome, onHostSystemDefaultSelected, selection } = fixture
    runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
      const current = store.getSettings().activeCodexManagedAccountIdsByRuntime
      store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { ...current?.wsl } }
      })
    })
    const result = await selection.remove('removed')
    expect(result.activeAccountId).toBeNull()
    expect(store.updateCodexAccountSettingsAndResetLedgerAndFlush).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null }),
      { version: 1, attempts: [] }
    )
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Debian'
    })
    expect(onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })

  it('reconciles a pruned WSL selection when removing an inactive host account', async () => {
    const { runtimeHome, onHostSystemDefaultSelected, selection } = removalFixture(
      [account('removed')],
      null
    )
    await selection.remove('removed')
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Debian'
    })
    expect(onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })

  it('reconciles another runtime newly cleared by self-healing', async () => {
    const { store, runtimeHome, selection } = removalFixture(
      [account('active-host'), account('removed'), account('active-wsl', 'wsl')],
      'active-host'
    )
    runtimeHome.syncForCurrentSelection.mockImplementationOnce(() => {
      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: {
          host: 'active-host',
          wsl: { Ubuntu: null, Debian: null }
        }
      })
    })
    await selection.remove('removed')
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.wsl.Ubuntu).toBeNull()
  })

  it('continues restoring WSL runtimes when host restoration fails', async () => {
    const { store, runtimeHome, selection, removeManagedHome } = removalFixture(
      [account('active-host'), account('removed', 'wsl')],
      'active-host'
    )
    let restoring = false
    const restored: unknown[] = []
    runtimeHome.syncForCurrentSelection.mockImplementation((target) => {
      if (!restoring) {
        return
      }
      restored.push(target)
      if (target?.runtime === 'host') {
        throw new Error('host restore failed')
      }
    })
    store.updateCodexAccountSettingsAndResetLedgerAndFlush.mockImplementationOnce(async () => {
      restoring = true
      throw new Error('disk full')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(selection.remove('removed')).rejects.toThrow('disk full')
      expect(restored).toContainEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(restored).toContainEqual({ runtime: 'wsl', wslDistro: 'Debian' })
      expect(logged).toHaveBeenCalledWith(
        '[codex-accounts] Failed to restore runtime after account removal rollback:',
        expect.objectContaining({ message: 'host restore failed' })
      )
      expect(removeManagedHome).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('restores every touched runtime and leaves the home intact when persistence fails', async () => {
    const { store, runtimeHome, removeManagedHome, onHostSystemDefaultSelected, selection } =
      removalFixture([account('active-host'), account('removed', 'wsl')], 'active-host')
    const before = structuredClone(store.getSettings())
    const observations: { target: unknown; selection: unknown }[] = []
    runtimeHome.syncForCurrentSelection.mockImplementation((target) => {
      observations.push({
        target,
        selection: structuredClone(store.getSettings().activeCodexManagedAccountIdsByRuntime)
      })
    })
    store.updateCodexAccountSettingsAndResetLedgerAndFlush.mockRejectedValueOnce(
      new Error('disk full')
    )
    await expect(selection.remove('removed')).rejects.toThrow('disk full')
    expect(store.getSettings().codexManagedAccounts).toEqual(before.codexManagedAccounts)
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual(
      before.activeCodexManagedAccountIdsByRuntime
    )
    for (const target of [
      { runtime: 'host' },
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      { runtime: 'wsl', wslDistro: 'Debian' }
    ]) {
      expect(observations).toContainEqual({
        target,
        selection: before.activeCodexManagedAccountIdsByRuntime
      })
    }
    expect(removeManagedHome).not.toHaveBeenCalled()
    expect(onHostSystemDefaultSelected).not.toHaveBeenCalled()
  })
})
