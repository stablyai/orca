export const MAX_PAGE_INITIATED_TABS_PER_WINDOW = 4
export const PAGE_INITIATED_TAB_WINDOW_MS = 2_000

export type PageInitiatedTabBudget = {
  /** Call only when opening a tab; successful calls consume the budget. */
  tryConsume: (now: number) => boolean
}

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
