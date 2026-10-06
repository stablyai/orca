import { expect, it, vi } from 'vitest'
import { CodexAccountRegistration } from './codex-account-registration'
import { createSettings, createStore } from './service-test-harness'

function fixture(fails = false) {
  const store = createStore(
    createSettings({
      agentLaunchProfiles: [],
      activeCodexManagedAccountId: 'existing',
      activeCodexManagedAccountIdsByRuntime: { host: 'existing', wsl: {} }
    })
  )
  const runtimeHome = { syncForCurrentSelection: vi.fn(), clearLastWrittenAuthJson: vi.fn() }
  const remove = vi.fn()
  const dependencies = {
    store,
    runtimeHome,
    rateLimits: { refreshForCodexAccountChange: vi.fn().mockResolvedValue(undefined) },
    selection: {
      snapshot: () => ({
        accounts: store.getSettings().codexManagedAccounts,
        activeAccountId: store.getSettings().activeCodexManagedAccountId
      })
    },
    managedHomes: {
      create: async () => ({
        managedHomePath: '/synthetic/new',
        managedHomeRuntime: 'host',
        wslDistro: null,
        wslLinuxHomePath: null
      }),
      removeUnlessUnproven: remove
    },
    managedHomePaths: {},
    configMirror: {
      readForManagedHome: vi.fn(),
      assertOAuthAccountAddAllowed: vi.fn(),
      safeSyncIntoManagedHome: vi.fn(),
      safeSyncToManagedHomes: vi.fn()
    },
    login: async () => {
      if (fails) {
        throw new Error('cancelled')
      }
    },
    readIdentityFromHome: () => ({
      email: 'new@example.com',
      providerAccountId: 'new',
      workspaceLabel: null,
      workspaceAccountId: 'new'
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only add-path collaborators are exercised by this focused registration fixture.
  const registration = new CodexAccountRegistration(dependencies as never)
  return { registration, store, runtimeHome, remove }
}
it('registers profile login without activating it or creating a launcher', async () => {
  const { registration, store, runtimeHome } = fixture()
  await registration.add({ activate: false })
  expect(store.getSettings().codexManagedAccounts).toHaveLength(1)
  expect(store.getSettings().activeCodexManagedAccountId).toBe('existing')
  expect(store.getSettings().activeCodexManagedAccountIdsByRuntime?.host).toBe('existing')
  expect(store.getSettings().agentLaunchProfiles).toEqual([])
  expect(runtimeHome.syncForCurrentSelection).not.toHaveBeenCalled()
  expect(runtimeHome.clearLastWrittenAuthJson).not.toHaveBeenCalled()
})
it('preserves default activation', async () => {
  const { registration, store, runtimeHome } = fixture()
  await registration.add()
  expect(store.getSettings().activeCodexManagedAccountId).toBe(
    store.getSettings().codexManagedAccounts[0].id
  )
  expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
})
it('cancelled login creates neither account nor launcher', async () => {
  const { registration, store, remove } = fixture(true)
  await expect(registration.add({ activate: false })).rejects.toThrow('cancelled')
  expect(store.getSettings().codexManagedAccounts).toEqual([])
  expect(store.getSettings().agentLaunchProfiles).toEqual([])
  expect(remove).toHaveBeenCalled()
})
