import { describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type * as Os from 'node:os'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { CodexAccountSelection } from './codex-account-selection'
import {
  createManagedHome,
  createRateLimits,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof Os>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

function account(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: createManagedHome(testState.userDataDir, id),
    managedHomeRuntime: 'host',
    wslDistro: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

async function fixture(host: string | null = 'active') {
  const accounts = [account('active'), account('inactive')]
  const store = createStore(
    createSettings({
      codexManagedAccounts: accounts,
      activeCodexManagedAccountId: host,
      activeCodexManagedAccountIdsByRuntime: { host, wsl: {} }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies the settings reads and selection updates used by runtime reconciliation.
  const runtimeHome = new CodexRuntimeHomeService(store as never)
  const sync = vi.spyOn(runtimeHome, 'syncForCurrentSelection')
  const rateLimits = createRateLimits()
  const removal = vi.fn()
  const selection = new CodexAccountSelection({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture implements the removal's settings operations.
    store: store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture supplies refresh and cache eviction.
    rateLimits: rateLimits as never,
    runtimeHome,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Removal does not use the config mirror.
    configMirror: {} as never,
    lifecycle: {},
    resolveSystemDefault: () => ({
      hasAuth: false,
      authKind: 'none',
      email: null,
      providerAccountId: null,
      workspaceLabel: null
    }),
    removeManagedHome: removal,
    discardResetAttempts: vi.fn().mockResolvedValue(undefined)
  })
  return { store, accounts, sync, rateLimits, removal, selection }
}

describe('inactive Codex account removal', () => {
  registerCodexAccountsTestHomes()

  it('preserves the active quota display without reconciling an unchanged trusted home', async () => {
    const { selection, sync, rateLimits, removal } = await fixture()
    expect((await selection.remove('inactive')).activeAccountId).toBe('active')
    expect(sync).not.toHaveBeenCalled()
    expect(rateLimits.refreshForCodexAccountChange).not.toHaveBeenCalled()
    expect(rateLimits.evictInactiveCodexCache).toHaveBeenCalledWith('inactive')
    expect(removal).toHaveBeenCalledOnce()
  })

  it('still reconciles and refreshes when the active account is removed', async () => {
    const { selection, sync, rateLimits } = await fixture()
    expect((await selection.remove('active')).activeAccountId).toBeNull()
    expect(sync).toHaveBeenCalledOnce()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce()
  })

  it('does not skip self-healing of an untrusted active home', async () => {
    const { accounts, selection, sync, rateLimits } = await fixture()
    rmSync(join(accounts[0].managedHomePath, '.orca-managed-home'))
    expect((await selection.remove('inactive')).activeAccountId).toBeNull()
    expect(sync).toHaveBeenCalledOnce()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce()
  })

  it('preserves the existing system-default reconciliation', async () => {
    const { selection, sync, rateLimits } = await fixture(null)
    await selection.remove('inactive')
    expect(sync).toHaveBeenCalledOnce()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce()
  })

  it('does not skip reconciliation when a different runtime has a stale selection', async () => {
    const { store, selection, sync, rateLimits } = await fixture()
    store.updateSettings({
      activeCodexManagedAccountIdsByRuntime: { host: 'active', wsl: { Ubuntu: 'missing' } }
    })
    await selection.remove('inactive')
    expect(sync).toHaveBeenCalledOnce()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce()
  })

  it('does not infer WSL runtime ownership from a trusted host home', async () => {
    const { store, accounts, selection, sync, rateLimits } = await fixture()
    store.updateSettings({
      codexManagedAccounts: [
        accounts[0],
        { ...accounts[1], managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
      ]
    })
    await selection.remove('inactive')
    expect(sync).toHaveBeenCalledOnce()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledOnce()
  })
})
