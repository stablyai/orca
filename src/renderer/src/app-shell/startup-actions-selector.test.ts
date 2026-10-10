import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  resetStartupActionsSelectorCacheForTest,
  selectStartupActions,
  type StartupActions
} from './startup-actions-selector'

type StartupTestState = StartupActions & { publication: number }

function makeActions(): StartupActions {
  return {
    fetchReposForAllHosts: vi.fn(),
    awaitLocalRepoCatalogSettlement: vi.fn(),
    fetchProjectGroupsForAllHosts: vi.fn(),
    fetchFolderWorkspacesForAllHosts: vi.fn(),
    fetchAllWorktrees: vi.fn(),
    fetchWorktrees: vi.fn(),
    fetchWorktreeLineage: vi.fn(),
    fetchOrcaProfiles: vi.fn(),
    fetchSettings: vi.fn(),
    awaitOwnerWorktreeVisibilityDefaultsHydration: vi.fn(),
    fetchKeybindings: vi.fn(),
    initGitHubCache: vi.fn(),
    hydrateWorkspaceSession: vi.fn(),
    hydrateTabsSession: vi.fn(),
    hydrateEditorSession: vi.fn(),
    hydrateBrowserSession: vi.fn(),
    fetchBrowserSessionProfiles: vi.fn(),
    reconnectPersistedTerminals: vi.fn(),
    setTerminalStartupRestorationReady: vi.fn(),
    setDeferredSshReconnectTargets: vi.fn(),
    removeDeferredSshReconnectTarget: vi.fn(),
    setSshConnectionState: vi.fn(),
    hydratePersistedUI: vi.fn(),
    setHydrationSucceeded: vi.fn(),
    pruneLastVisitedTimestamps: vi.fn(),
    seedActiveWorktreeLastVisitedIfMissing: vi.fn()
  } as StartupActions
}

describe('startup action selector', () => {
  beforeEach(() => {
    resetStartupActionsSelectorCacheForTest()
  })

  it('reuses one action bundle across 1,000 repeated reads', () => {
    const actions = makeActions()
    const first = selectStartupActions(actions)

    for (let read = 0; read < 1_000; read += 1) {
      expect(selectStartupActions(actions)).toBe(first)
    }
  })

  it('rebuilds the bundle when one action reference changes', () => {
    const actions = makeActions()
    const first = selectStartupActions(actions)
    const replacement = { ...actions, fetchSettings: vi.fn() } as StartupActions

    const next = selectStartupActions(replacement)
    expect(next).not.toBe(first)

    for (let read = 0; read < 1_000; read += 1) {
      expect(selectStartupActions(replacement)).toBe(next)
    }
  })

  it('keeps the selected projection stable across 1,000 unrelated publications', () => {
    const actions = makeActions()
    const store = createStore<StartupTestState>(() => ({ ...actions, publication: 0 }))
    let publicationCount = 0
    let projectionChangeCount = 0
    let previousProjection = selectStartupActions(store.getState())
    const unsubscribe = store.subscribe((state) => {
      publicationCount += 1
      const projection = selectStartupActions(state)
      if (projection !== previousProjection) {
        projectionChangeCount += 1
      }
      previousProjection = projection
    })

    for (let publication = 1; publication <= 1_000; publication += 1) {
      store.setState({ publication })
    }

    expect(publicationCount).toBe(1_000)
    expect(projectionChangeCount).toBe(0)
    unsubscribe()
  })
})
