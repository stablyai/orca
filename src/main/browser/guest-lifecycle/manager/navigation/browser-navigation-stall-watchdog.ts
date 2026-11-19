import { webContents } from 'electron'
import type {
  BrowserLoadStall,
  BrowserLoadStallPhase
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { isEligibleLocalCertificateHost } from '../../../../../shared/browser/navigation/browser-url'
import { startSpan } from '../../../../observability/tracer'
import { observeBrowserGuestRequests } from '../../../sessions/requests/browser-session-web-request-observer'
import { readBrowserGuestSemanticVisibility } from '../registration/browser-guest-idle-protection'

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

function countHiddenSameOriginPages(guest: Electron.WebContents, origin: string): number {
  let count = 0
  for (const other of webContents.getAllWebContents()) {
    if (
      other !== guest &&
      !other.isDestroyed() &&
      other.session === guest.session &&
      readBrowserGuestSemanticVisibility(other) === false &&
      webOrigin(other.getURL())?.origin === origin
    ) {
      count++
    }
  }
  return count
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
  let pending: PendingLoad | null = null

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
    scheme: load.url.protocol === 'https:' ? 'https' : 'http',
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
        'browser.load.scheme': current.scheme,
        'browser.load.local': isEligibleLocalCertificateHost(load.url.hostname),
        'browser.load.port': Number(load.url.port) || (current.scheme === 'https' ? 443 : 80),
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

  const stopRequests = observeBrowserGuestRequests(guest.id, (session, event, details) => {
    const load = pending
    if (!load || details.resourceType !== 'mainFrame' || session !== guest.session) {
      return
    }
    if (event === 'onBeforeRequest') {
      load.requestId = details.id
      load.phase = 'held'
    } else if (event === 'onBeforeSendHeaders' && details.id === load.requestId) {
      load.phase = 'sent'
    }
  })

  const committed = (): void => finish('committed')
  const failed = (
    _event: Electron.Event,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) {
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
