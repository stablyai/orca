import type { MobileBrowserViewMode } from './browser-screencast-request'

export const BROWSER_VIEW_MODE_STATE_LIMIT = 40
export const BROWSER_VIEW_MODE_PAGE_KEY_MAX_CHARACTERS = 4_096
const browserViewModeByPageKey = new Map<string, MobileBrowserViewMode>()

export function getInitialMobileBrowserViewMode(
  worktreeId: string,
  browserPageId: string | null
): MobileBrowserViewMode {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  if (!pageKey) {
    return 'web'
  }
  return browserViewModeByPageKey.get(pageKey) ?? 'web'
}

export function saveMobileBrowserViewMode(
  worktreeId: string,
  browserPageId: string | null,
  viewMode: MobileBrowserViewMode
): void {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  if (!pageKey) {
    return
  }
  browserViewModeByPageKey.delete(pageKey)
  browserViewModeByPageKey.set(pageKey, viewMode)
  while (browserViewModeByPageKey.size > BROWSER_VIEW_MODE_STATE_LIMIT) {
    const oldestKey = browserViewModeByPageKey.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    browserViewModeByPageKey.delete(oldestKey)
  }
}

export function clearMobileBrowserViewModeState(): void {
  browserViewModeByPageKey.clear()
}

function makeBrowserViewModePageKey(
  worktreeId: string,
  browserPageId: string | null
): string | null {
  if (!browserPageId) {
    return null
  }
  const key = `${worktreeId}:${browserPageId}`
  return key.length <= BROWSER_VIEW_MODE_PAGE_KEY_MAX_CHARACTERS ? key : null
}
