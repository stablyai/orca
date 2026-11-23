import {
  MAX_REMOTE_TAB_FAVICON_URL_LENGTH,
  remoteTabFaviconUrl
} from '../../../../shared/browser/browser-favicon-url'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { iconDataUrl, type IconPngEncoder } from '../../sidebar-inputs/repo-icons/icon-data-url'
import {
  fetchRemoteRepoIcon,
  type RepoIconFetch
} from '../../sidebar-inputs/repo-icons/repo-icon-remote-fetch'
import { isBlockedHost } from '../../../link-preview/link-preview-address-guard'
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
      /** The page's own route; null leaves its icon unfetched, since any other route exposes this host's network. */
      fetchFor: (browserPageId: string) => RepoIconFetch | null
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
      const dataUrl = this.read(tab.faviconUrl, snapshot.worktree, tab.browserPageId)
      if (!dataUrl) {
        return tab
      }
      changed = true
      return { ...tab, faviconUrl: dataUrl }
    })
    return changed ? { ...snapshot, tabs } : snapshot
  }

  private read(url: string, worktreeId: string, browserPageId: string | null): string | null {
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
    const fetch = browserPageId ? this.options.fetchFor(browserPageId) : null
    if (!fetch) {
      return null
    }
    const worktreeIds = new Set([worktreeId])
    this.waiting.set(url, worktreeIds)
    void this.produce(url, fetch).then((dataUrl) => {
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

  private async produce(url: string, fetch: RepoIconFetch): Promise<string | null> {
    try {
      // Every redirect hop meets the rule the published URL did, and none names a private network address.
      const image = await fetchRemoteRepoIcon(
        url,
        fetch,
        undefined,
        (hop) => remoteTabFaviconUrl(hop.href) !== null && !isBlockedHost(hop.hostname)
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
      fetchFor: (browserPageId) =>
        getRuntimeDesktopSurface().browserTabFaviconFetch?.(browserPageId) ?? null,
      encoder: () => getRuntimeDesktopSurface().encodeRepoIconPng,
      onInlined: (worktreeId) => runtime.touchMobileSessionTabsForWorktree(worktreeId)
    })
    runtimeFavicons.set(runtime, favicons)
  }
  return favicons.inline(snapshot)
}
