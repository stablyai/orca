/** Bounded so one hostile click cannot plant an unbounded number of tabs. */
export const MAX_PAGE_INITIATED_TABS_PER_WINDOW = 4
export const PAGE_INITIATED_TAB_WINDOW_MS = 2_000

export type PageInitiatedTabBudget = {
  /** Records the grant when it returns true; call only when the tab is actually being opened. */
  tryConsume: (now: number) => boolean
}

/** Rolling window, so it absorbs a same-tick `window.open` loop without capping real browsing. */
export function createPageInitiatedTabBudget(
  maxPerWindow = MAX_PAGE_INITIATED_TABS_PER_WINDOW,
  windowMs = PAGE_INITIATED_TAB_WINDOW_MS
): PageInitiatedTabBudget {
  let grants: number[] = []
  return {
    tryConsume: (now) => {
      grants = grants.filter((grantedAt) => now - grantedAt < windowMs)
      if (grants.length >= maxPerWindow) {
        return false
      }
      grants.push(now)
      return true
    }
  }
}
