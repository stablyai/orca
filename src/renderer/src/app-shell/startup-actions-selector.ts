import type { AppState } from '../store/types'

export type StartupActions = Pick<
  AppState,
  | 'fetchReposForAllHosts'
  | 'awaitLocalRepoCatalogSettlement'
  | 'fetchProjectGroupsForAllHosts'
  | 'fetchFolderWorkspacesForAllHosts'
  | 'fetchAllWorktrees'
  | 'fetchWorktrees'
  | 'fetchWorktreeLineage'
  | 'fetchOrcaProfiles'
  | 'fetchSettings'
  | 'awaitOwnerWorktreeVisibilityDefaultsHydration'
  | 'fetchKeybindings'
  | 'initGitHubCache'
  | 'hydrateWorkspaceSession'
  | 'hydrateTabsSession'
  | 'hydrateEditorSession'
  | 'hydrateBrowserSession'
  | 'fetchBrowserSessionProfiles'
  | 'reconnectPersistedTerminals'
  | 'setTerminalStartupRestorationReady'
  | 'setDeferredSshReconnectTargets'
  | 'removeDeferredSshReconnectTarget'
  | 'setSshConnectionState'
  | 'hydratePersistedUI'
  | 'setHydrationSucceeded'
  | 'pruneLastVisitedTimestamps'
  | 'seedActiveWorktreeLastVisitedIfMissing'
>

let cachedStartupActions: StartupActions | null = null

/** Keeps the always-mounted startup subscription stable across unrelated store writes. */
export function selectStartupActions(state: StartupActions): StartupActions {
  if (
    cachedStartupActions &&
    cachedStartupActions.fetchReposForAllHosts === state.fetchReposForAllHosts &&
    cachedStartupActions.awaitLocalRepoCatalogSettlement ===
      state.awaitLocalRepoCatalogSettlement &&
    cachedStartupActions.fetchProjectGroupsForAllHosts === state.fetchProjectGroupsForAllHosts &&
    cachedStartupActions.fetchFolderWorkspacesForAllHosts ===
      state.fetchFolderWorkspacesForAllHosts &&
    cachedStartupActions.fetchAllWorktrees === state.fetchAllWorktrees &&
    cachedStartupActions.fetchWorktrees === state.fetchWorktrees &&
    cachedStartupActions.fetchWorktreeLineage === state.fetchWorktreeLineage &&
    cachedStartupActions.fetchOrcaProfiles === state.fetchOrcaProfiles &&
    cachedStartupActions.fetchSettings === state.fetchSettings &&
    cachedStartupActions.awaitOwnerWorktreeVisibilityDefaultsHydration ===
      state.awaitOwnerWorktreeVisibilityDefaultsHydration &&
    cachedStartupActions.fetchKeybindings === state.fetchKeybindings &&
    cachedStartupActions.initGitHubCache === state.initGitHubCache &&
    cachedStartupActions.hydrateWorkspaceSession === state.hydrateWorkspaceSession &&
    cachedStartupActions.hydrateTabsSession === state.hydrateTabsSession &&
    cachedStartupActions.hydrateEditorSession === state.hydrateEditorSession &&
    cachedStartupActions.hydrateBrowserSession === state.hydrateBrowserSession &&
    cachedStartupActions.fetchBrowserSessionProfiles === state.fetchBrowserSessionProfiles &&
    cachedStartupActions.reconnectPersistedTerminals === state.reconnectPersistedTerminals &&
    cachedStartupActions.setTerminalStartupRestorationReady ===
      state.setTerminalStartupRestorationReady &&
    cachedStartupActions.setDeferredSshReconnectTargets === state.setDeferredSshReconnectTargets &&
    cachedStartupActions.removeDeferredSshReconnectTarget ===
      state.removeDeferredSshReconnectTarget &&
    cachedStartupActions.setSshConnectionState === state.setSshConnectionState &&
    cachedStartupActions.hydratePersistedUI === state.hydratePersistedUI &&
    cachedStartupActions.setHydrationSucceeded === state.setHydrationSucceeded &&
    cachedStartupActions.pruneLastVisitedTimestamps === state.pruneLastVisitedTimestamps &&
    cachedStartupActions.seedActiveWorktreeLastVisitedIfMissing ===
      state.seedActiveWorktreeLastVisitedIfMissing
  ) {
    return cachedStartupActions
  }

  cachedStartupActions = {
    fetchReposForAllHosts: state.fetchReposForAllHosts,
    awaitLocalRepoCatalogSettlement: state.awaitLocalRepoCatalogSettlement,
    fetchProjectGroupsForAllHosts: state.fetchProjectGroupsForAllHosts,
    fetchFolderWorkspacesForAllHosts: state.fetchFolderWorkspacesForAllHosts,
    fetchAllWorktrees: state.fetchAllWorktrees,
    fetchWorktrees: state.fetchWorktrees,
    fetchWorktreeLineage: state.fetchWorktreeLineage,
    fetchOrcaProfiles: state.fetchOrcaProfiles,
    fetchSettings: state.fetchSettings,
    awaitOwnerWorktreeVisibilityDefaultsHydration:
      state.awaitOwnerWorktreeVisibilityDefaultsHydration,
    fetchKeybindings: state.fetchKeybindings,
    initGitHubCache: state.initGitHubCache,
    hydrateWorkspaceSession: state.hydrateWorkspaceSession,
    hydrateTabsSession: state.hydrateTabsSession,
    hydrateEditorSession: state.hydrateEditorSession,
    hydrateBrowserSession: state.hydrateBrowserSession,
    fetchBrowserSessionProfiles: state.fetchBrowserSessionProfiles,
    reconnectPersistedTerminals: state.reconnectPersistedTerminals,
    setTerminalStartupRestorationReady: state.setTerminalStartupRestorationReady,
    setDeferredSshReconnectTargets: state.setDeferredSshReconnectTargets,
    removeDeferredSshReconnectTarget: state.removeDeferredSshReconnectTarget,
    setSshConnectionState: state.setSshConnectionState,
    hydratePersistedUI: state.hydratePersistedUI,
    setHydrationSucceeded: state.setHydrationSucceeded,
    pruneLastVisitedTimestamps: state.pruneLastVisitedTimestamps,
    seedActiveWorktreeLastVisitedIfMissing: state.seedActiveWorktreeLastVisitedIfMissing
  }
  return cachedStartupActions
}

export function resetStartupActionsSelectorCacheForTest(): void {
  cachedStartupActions = null
}
