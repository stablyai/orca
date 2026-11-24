import type { BridgeNavigateBackOutcome } from '../host-bridge/bridge-host-contract'

// Each page is its own document, so the next one learns its depth from the one that navigated to it.
const NEXT_DEPTH_KEY = 'orca.mobileWeb.nextDepth'

export type BrowserShellHistory = {
  navigate: (href: string, replace: boolean) => void
  back: () => BridgeNavigateBackOutcome
}

/**
 * Tracks how many of this tab's history entries are the page's, so Back at the entry route stays
 * put as it does in the app, instead of leaving for whatever the tab showed before the link.
 */
export function createBrowserShellHistory(openedFromLink: boolean): BrowserShellHistory {
  const depth = openedFromLink ? 0 : (readStateDepth() ?? takeNextDepth() ?? 0)
  history.replaceState({ ...readState(), orcaDepth: depth }, '')
  return {
    navigate: (href, replace) => {
      // Only /h/ routes are served; the rest, like the host list at /, are app screens a tab lacks.
      if (!href.startsWith('/h/')) {
        console.warn('[browser-shell] no browser page for', href)
        return
      }
      writeNextDepth(replace ? depth : depth + 1)
      if (replace) {
        window.location.replace(href)
      } else {
        window.location.assign(href)
      }
    },
    back: () => {
      if (depth === 0) {
        return 'nothing-to-pop'
      }
      history.back()
      return 'popped'
    }
  }
}

function readState(): Record<string, unknown> {
  const state: unknown = history.state
  return typeof state === 'object' && state !== null ? { ...state } : {}
}

function readStateDepth(): number | null {
  const depth = readState().orcaDepth
  return typeof depth === 'number' ? depth : null
}

function takeNextDepth(): number | null {
  try {
    const value = sessionStorage.getItem(NEXT_DEPTH_KEY)
    sessionStorage.removeItem(NEXT_DEPTH_KEY)
    const depth = value === null ? Number.NaN : Number(value)
    return Number.isInteger(depth) && depth >= 0 ? depth : null
  } catch {
    return null
  }
}

function writeNextDepth(depth: number): void {
  try {
    sessionStorage.setItem(NEXT_DEPTH_KEY, String(depth))
  } catch {
    // Without storage the next page counts as an entry, so Back there stays put rather than leaving.
  }
}
