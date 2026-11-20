import type {
  BrowserLoadStall,
  BrowserLoadStallPhase
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { isEligibleLocalCertificateHost } from '../../../../../shared/browser/navigation/browser-url'
import { startSpan } from '../../../../observability/tracer'
import { observeBrowserGuestRequests } from '../../../sessions/requests/browser-session-web-request-observer'
import { blockedMainFrameRequestBeingReported } from '../../../sessions/requests/browser-session-request-decisions'
import {
  onBrowserGuestSemanticVisibilityChanged,
  readBrowserGuestSemanticVisibility
} from '../registration/browser-guest-idle-protection'

/** Long enough that a slow server or a cold dev-server compile isn't called stuck. */
export const BROWSER_LOAD_STALL_AFTER_MS = 5_000

type PendingLoad = {
  origin: string
  url: URL
  startedAt: number
  phase: BrowserLoadStallPhase
  requestId: number | null
  timer: ReturnType<typeof setTimeout> | null
  stalled: boolean
}

function webOrigin(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// Hidden watched pages per session and committed origin, kept current on commit and on
// visibility change, so a stall reads one number however many tabs share the site.
type IndexedGuest = { session: Electron.Session; origin: string | null; hidden: boolean }
const indexedGuests = new Map<Electron.WebContents, IndexedGuest>()
const hiddenPages = new Map<Electron.Session, Map<string, number>>()

function countHidden(entry: IndexedGuest, delta: 1 | -1): void {
  if (!entry.hidden || !entry.origin) {
    return
  }
  let bySession = hiddenPages.get(entry.session)
  if (!bySession) {
    bySession = new Map()
    hiddenPages.set(entry.session, bySession)
  }
  const next = (bySession.get(entry.origin) ?? 0) + delta
  if (next > 0) {
    bySession.set(entry.origin, next)
  } else {
    bySession.delete(entry.origin)
    if (bySession.size === 0) {
      hiddenPages.delete(entry.session)
    }
  }
}

function reindex(guest: Electron.WebContents, origin: string | null): void {
  const entry = indexedGuests.get(guest)
  if (!entry) {
    return
  }
  countHidden(entry, -1)
  entry.origin = origin
  entry.hidden = readBrowserGuestSemanticVisibility(guest) === false
  countHidden(entry, 1)
}

onBrowserGuestSemanticVisibilityChanged((guest) => {
  const entry = indexedGuests.get(guest)
  if (entry) {
    reindex(guest, entry.origin)
  }
})

function countHiddenSameOriginPages(guest: Electron.WebContents, origin: string): number {
  const entry = indexedGuests.get(guest)
  if (!entry) {
    return 0
  }
  const count = hiddenPages.get(entry.session)?.get(origin) ?? 0
  return entry.hidden && entry.origin === origin ? count - 1 : count
}

/**
 * Reports a main-frame load that hasn't committed after BROWSER_LOAD_STALL_AFTER_MS, and the
 * phase it stopped in, from navigation events and the requests Orca already observes. Six hidden
 * pages holding long-lived HTTP/1.1 requests to one host fill Chromium's per-host socket pool, and
 * reloading the stuck page doesn't help; the hidden-page count says when that may be the cause.
 */
export function installBrowserNavigationStallWatchdog(
  guest: Electron.WebContents,
  report: (stall: BrowserLoadStall | null) => void
): () => void {
  // Read once: a destroyed guest throws on .session, and dispose can run after destruction.
  const session = guest.session
  let pending: PendingLoad | null = null
  indexedGuests.set(guest, { session, origin: null, hidden: false })
  const recordCommit = (): void => {
    reindex(guest, guest.isDestroyed() ? null : (webOrigin(guest.getURL())?.origin ?? null))
  }
  recordCommit()

  const finish = (outcome: 'committed' | 'failed' | 'stopped' | 'replaced' | 'closed'): void => {
    const load = pending
    if (!load) {
      return
    }
    pending = null
    if (load.timer) {
      clearTimeout(load.timer)
    }
    if (!load.stalled) {
      return
    }
    startSpan('browser.loadStallEnded', {
      attributes: {
        'browser.load.outcome': outcome,
        'browser.load.phase': load.phase,
        'browser.load.stalledMs': Math.round(performance.now() - load.startedAt)
      }
    }).end()
    report(null)
  }

  const describe = (load: PendingLoad): BrowserLoadStall => ({
    phase: load.phase,
    host: load.url.host,
    hiddenSameOriginPages: countHiddenSameOriginPages(guest, load.origin)
  })

  const stall = (load: PendingLoad): void => {
    load.timer = null
    if (pending !== load || guest.isDestroyed()) {
      return
    }
    load.stalled = true
    const current = describe(load)
    startSpan('browser.loadStalled', {
      attributes: {
        'browser.load.phase': current.phase,
        'browser.load.scheme': load.url.protocol.slice(0, -1),
        'browser.load.local': isEligibleLocalCertificateHost(load.url.hostname),
        'browser.load.port': Number(load.url.port) || (load.url.protocol === 'https:' ? 443 : 80),
        'browser.load.hiddenSameOriginPages': current.hiddenSameOriginPages
      }
    }).end()
    report(current)
  }

  const started = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    finish('replaced')
    const url = webOrigin(details.url)
    if (!url) {
      return
    }
    const load: PendingLoad = {
      origin: url.origin,
      url,
      startedAt: performance.now(),
      phase: 'no-request-seen',
      requestId: null,
      timer: null,
      stalled: false
    }
    load.timer = setTimeout(() => stall(load), BROWSER_LOAD_STALL_AFTER_MS)
    load.timer.unref?.()
    pending = load
  }

  // The bubble and the hidden-page count follow a redirect to its new host.
  const redirected = (
    details: Electron.Event<Electron.WebContentsDidRedirectNavigationEventParams>
  ): void => {
    const url = details.isMainFrame && pending ? webOrigin(details.url) : null
    if (pending && url) {
      pending.url = url
      pending.origin = url.origin
      if (pending.stalled) {
        report(describe(pending))
      }
    }
  }

  const stopRequests = observeBrowserGuestRequests(guest.id, (requestSession, event, details) => {
    const load = pending
    if (!load || details.resourceType !== 'mainFrame' || requestSession !== session) {
      return
    }
    if (event === 'onBeforeRequest') {
      load.requestId = details.id
      load.phase = 'held'
    } else if (event === 'onBeforeSendHeaders' && details.id === load.requestId) {
      load.phase = 'sent'
    }
  })

  const committed = (): void => {
    recordCommit()
    finish('committed')
  }
  // Electron reports no failure for a navigation a newer one replaced; only an extension block
  // decided late can arrive after that, so it ends the watch only if it names this load's request.
  const failed = (
    _event: Electron.Event,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    const blocked = blockedMainFrameRequestBeingReported()
    if (isMainFrame && pending && (blocked === null || blocked === pending.requestId)) {
      finish('failed')
    }
  }
  // A 204 or a download ends the navigation without a commit or a failure.
  const stopped = (): void => {
    if (!guest.isLoadingMainFrame()) {
      finish('stopped')
    }
  }
  const closed = (): void => finish('closed')

  guest.on('did-start-navigation', started)
  guest.on('did-redirect-navigation', redirected)
  guest.on('did-navigate', committed)
  guest.on('did-fail-load', failed)
  guest.on('did-stop-loading', stopped)
  guest.on('destroyed', closed)
  return () => {
    finish('closed')
    stopRequests()
    const entry = indexedGuests.get(guest)
    if (entry) {
      countHidden(entry, -1)
      indexedGuests.delete(guest)
    }
    if (!guest.isDestroyed()) {
      guest.off('did-start-navigation', started)
      guest.off('did-redirect-navigation', redirected)
      guest.off('did-navigate', committed)
      guest.off('did-fail-load', failed)
      guest.off('did-stop-loading', stopped)
      guest.off('destroyed', closed)
    }
  }
}
