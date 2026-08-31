import type { AppState } from '../store/types'

export type WindowVisibilityActions = Pick<
  AppState,
  | 'refreshAllGitHub'
  | 'reportVisibleGitHubPRRefreshCandidates'
  | 'bumpGitHubPRVisibleRefreshGeneration'
>

let cachedActions: WindowVisibilityActions | null = null

/**
 * The App root stays mounted while terminal/status writes publish frequently. Keep the action
 * bundle stable when its function references are unchanged so those writes allocate nothing here.
 */
export function selectWindowVisibilityActions(
  state: WindowVisibilityActions
): WindowVisibilityActions {
  if (
    cachedActions &&
    cachedActions.refreshAllGitHub === state.refreshAllGitHub &&
    cachedActions.reportVisibleGitHubPRRefreshCandidates ===
      state.reportVisibleGitHubPRRefreshCandidates &&
    cachedActions.bumpGitHubPRVisibleRefreshGeneration ===
      state.bumpGitHubPRVisibleRefreshGeneration
  ) {
    return cachedActions
  }

  cachedActions = {
    refreshAllGitHub: state.refreshAllGitHub,
    reportVisibleGitHubPRRefreshCandidates: state.reportVisibleGitHubPRRefreshCandidates,
    bumpGitHubPRVisibleRefreshGeneration: state.bumpGitHubPRVisibleRefreshGeneration
  }
  return cachedActions
}

export function resetWindowVisibilityActionsSelectorCacheForTest(): void {
  cachedActions = null
}
