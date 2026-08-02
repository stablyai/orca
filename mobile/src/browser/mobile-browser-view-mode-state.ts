import type { MobileBrowserViewMode } from './browser-screencast-request'

const BROWSER_VIEW_MODE_STATE_LIMIT = 40
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
  return browserPageId ? `${worktreeId}:${browserPageId}` : null
}
