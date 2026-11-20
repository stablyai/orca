import {
  MAX_REMOTE_TAB_FAVICON_URL_LENGTH,
  remoteTabFaviconUrl
} from '../../../../shared/browser/browser-favicon-url'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { iconDataUrl, type IconPngEncoder } from '../../sidebar-inputs/repo-icons/icon-data-url'
import {
  fetchRemoteRepoIcon,
  runtimeIconFetch,
  type RepoIconFetch
} from '../../sidebar-inputs/repo-icons/repo-icon-remote-fetch'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

const FAVICON_LIMITS = {
  maxDataUrlLength: MAX_REMOTE_TAB_FAVICON_URL_LENGTH,
  maxDecodeEdgePx: 512,
  encodedEdgesPx: [32, 16]
} as const
const FAILURE_TTL_MS = 5 * 60 * 1000
// Generous so a busy host's open tabs never evict each other into a refetch loop.
const MAX_ENTRIES = 1024

/**
 * Tab favicons as small data URLs, because the phone's page shell loads no https image. A miss
 * publishes the https URL and republishes the waiting workspaces once the icon is inlined.
 */
export class BrowserTabFaviconDataUrls {
  // Insertion order is recency: a hit moves its entry to the end.
  private readonly inlined = new Map<string, { dataUrl: string | null; expiresAt: number }>()
  private readonly waiting = new Map<string, Set<string>>()

  constructor(
    private readonly options: {
      fetch: RepoIconFetch
      encoder: () => IconPngEncoder | undefined
      onInlined: (worktreeId: string) => void
      now?: () => number
    }
  ) {}

  inline(snapshot: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type !== 'browser' || !tab.faviconUrl?.startsWith('https:')) {
        return tab
      }
      const dataUrl = this.read(tab.faviconUrl, snapshot.worktree)
      if (!dataUrl) {
        return tab
      }
      changed = true
      return { ...tab, faviconUrl: dataUrl }
    })
    return changed ? { ...snapshot, tabs } : snapshot
  }

  private read(url: string, worktreeId: string): string | null {
    const entry = this.inlined.get(url)
    if (entry && entry.expiresAt > this.now()) {
      this.inlined.delete(url)
      this.inlined.set(url, entry)
      return entry.dataUrl
    }
    const waiting = this.waiting.get(url)
    if (waiting) {
      waiting.add(worktreeId)
      return null
    }
    const worktreeIds = new Set([worktreeId])
    this.waiting.set(url, worktreeIds)
    void this.produce(url).then((dataUrl) => {
      this.waiting.delete(url)
      this.remember(url, dataUrl)
      if (dataUrl) {
        for (const id of worktreeIds) {
          this.options.onInlined(id)
        }
      }
    })
    return null
  }

  private async produce(url: string): Promise<string | null> {
    try {
      // Every redirect hop meets the rule the published URL did, so none lands on this host's loopback.
      const image = await fetchRemoteRepoIcon(
        url,
        this.options.fetch,
        undefined,
        (hop) => remoteTabFaviconUrl(hop.href) !== null
      )
      return image ? iconDataUrl(image, FAVICON_LIMITS, this.options.encoder()) : null
    } catch {
      return null
    }
  }

  private remember(url: string, dataUrl: string | null): void {
    // An inlined icon stays for the process: re-fetching would flip the tab back to https meanwhile.
    this.inlined.delete(url)
    this.inlined.set(url, {
      dataUrl,
      expiresAt: dataUrl ? Number.POSITIVE_INFINITY : this.now() + FAILURE_TTL_MS
    })
    for (const oldest of this.inlined.keys()) {
      if (this.inlined.size <= MAX_ENTRIES) {
        break
      }
      this.inlined.delete(oldest)
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

const runtimeFavicons = new WeakMap<object, BrowserTabFaviconDataUrls>()

/** Inline with this runtime's cache; a finished icon republishes at a new version, since viewers drop same-version republishes. */
export function inlineRuntimeBrowserTabFavicons(
  runtime: { touchMobileSessionTabsForWorktree(worktreeId: string): void },
  snapshot: RuntimeMobileSessionTabsSnapshot
): RuntimeMobileSessionTabsSnapshot {
  let favicons = runtimeFavicons.get(runtime)
  if (!favicons) {
    favicons = new BrowserTabFaviconDataUrls({
      fetch: runtimeIconFetch,
      encoder: () => getRuntimeDesktopSurface().encodeRepoIconPng,
      onInlined: (worktreeId) => runtime.touchMobileSessionTabsForWorktree(worktreeId)
    })
    runtimeFavicons.set(runtime, favicons)
  }
  return favicons.inline(snapshot)
}
