export type MobileBrowserNavigationState = { canGoBack: boolean; canGoForward: boolean }

/** A host `navigation` refinement plus the tab props it refined, so a later tab update wins. */
export type MobileBrowserNavigationRefinement = MobileBrowserNavigationState & {
  base: MobileBrowserNavigationState
}

// Why: the tab props are the baseline every host publishes; the screencast `navigation` event is
// a newer-host refinement that only stands until the tab itself republishes navigability.
export function resolveMobileBrowserNavigationState(
  tab: MobileBrowserNavigationState,
  refinement: MobileBrowserNavigationRefinement | null
): MobileBrowserNavigationState {
  if (
    refinement &&
    refinement.base.canGoBack === tab.canGoBack &&
    refinement.base.canGoForward === tab.canGoForward
  ) {
    return { canGoBack: refinement.canGoBack, canGoForward: refinement.canGoForward }
  }
  return { canGoBack: tab.canGoBack, canGoForward: tab.canGoForward }
}
