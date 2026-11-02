import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  unifiedTabsByWorktree: {} as Record<string, unknown[]>,
  tabsByWorktree: {} as Record<string, unknown[]>
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

const { hydratedTabsSnapshot, rehydrateRepairedWorkspaces } =
  await import('./startup-repaired-workspaces')

// Main repaired two workspaces' saved tabs after this window read them; the user already changed
// one of them: only the untouched one is read again, the other keeps what the user did.
it('reads again only the repaired workspaces the user left untouched', async () => {
  state.unifiedTabsByWorktree = { untouched: [], changed: [], other: [] }
  state.tabsByWorktree = { untouched: [], changed: [], other: [] }
  const hydrated = hydratedTabsSnapshot()
  state.unifiedTabsByWorktree = { ...state.unifiedTabsByWorktree, changed: [{ id: 'new-tab' }] }
  const saved = { tabsByWorktree: {} }
  vi.stubGlobal('window', { api: { session: { get: vi.fn(async () => saved) } } })
  const actions = { hydrateWorkspaceSession: vi.fn(), hydrateTabsSession: vi.fn() }
  await rehydrateRepairedWorkspaces(['untouched', 'changed'], hydrated, actions as never, {})
  expect(actions.hydrateWorkspaceSession).toHaveBeenCalledExactlyOnceWith(saved, {
    replaceWorkspaceKeys: ['untouched']
  })
  expect(actions.hydrateTabsSession).toHaveBeenCalledExactlyOnceWith(saved, {
    replaceWorkspaceKeys: ['untouched']
  })
  // Nothing repaired: no read at all.
  await rehydrateRepairedWorkspaces([], hydrated, actions as never, {})
  expect(actions.hydrateTabsSession).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})
