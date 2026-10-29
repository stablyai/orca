import type { AppState } from '../store/types'

export type WindowVisibilityActions = Pick<
  AppState,
  | 'refreshAllGitHub'
  | 'reportVisibleGitHubPRRefreshCandidates'
  | 'bumpGitHubPRVisibleRefreshGeneration'
>

let cachedActions: WindowVisibilityActions | null = null

/** Keep the App action bundle stable across frequent terminal/status writes when function references match. */
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
