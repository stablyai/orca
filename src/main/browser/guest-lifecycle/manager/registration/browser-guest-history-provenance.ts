import { observeBrowserGuestRequests } from '../../../sessions/requests/browser-session-web-request-observer'

export type BrowserGuestHistoryProtection = {
  dirty: boolean | null
  navigating: boolean
  currentEdited: boolean
  coverageUnknown: boolean
  documentSeen: boolean
  knownGet: boolean
  historyEdits: boolean
  historyMethodUnknown: boolean
  mediaGranted: boolean
  episode: {
    url: string
    frame: Electron.WebFrameMain | null
    requestId: number | null
    method: string | null
    committed: boolean
    ambiguous: boolean
  } | null
}
export function installBrowserGuestHistoryProvenance(
  guest: Electron.WebContents,
  owner: BrowserGuestHistoryProtection,
  publish: () => void,
  invalidate: () => void,
  rederiveSoleHistory: () => void
): () => void {
  const navigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      if (
        owner.documentSeen &&
        (owner.dirty !== false || owner.coverageUnknown || guest.mainFrame.frames.length > 0)
      ) {
        owner.historyEdits = true
      }
      const previous = owner.episode
      const ambiguous = Boolean(previous && !previous.committed)
      if (ambiguous) {
        owner.historyMethodUnknown = true
      }
      owner.episode = {
        url: navigationUrl(details.url),
        frame: details.frame,
        requestId: null,
        method: null,
        committed: false,
        ambiguous
      }
      owner.knownGet = false
      owner.navigating = true
      invalidate()
    } else if (!details.isMainFrame) {
      publish()
    }
  }
  const committed = (_event: Electron.Event, url: string, status: number): void => {
    owner.documentSeen = true
    owner.currentEdited = false
    owner.coverageUnknown = false
    owner.mediaGranted = false
    const episode = owner.episode
    if (!episode) {
      owner.historyMethodUnknown = true
      return
    }
    episode.committed = true
    if (episode.url !== navigationUrl(url) || episode.requestId === null) {
      episode.ambiguous = true
    }
    owner.knownGet =
      !episode.ambiguous &&
      episode.method === 'GET' &&
      /^https?:/.test(url) &&
      Number.isInteger(status) &&
      status >= 200 &&
      status < 400
    if (!owner.knownGet) {
      owner.historyMethodUnknown = true
    }
    rederiveSoleHistory()
    publish()
  }
  const redirected = (
    details: Electron.Event<Electron.WebContentsDidRedirectNavigationEventParams>
  ): void => {
    if (details.isMainFrame) {
      if (owner.episode) {
        owner.episode.ambiguous = true
      }
      owner.historyMethodUnknown = true
      publish()
    }
  }
  const stopRequests = observeBrowserGuestRequests(guest.id, (session, event, details) => {
    if (
      event !== 'onBeforeRequest' ||
      details.resourceType !== 'mainFrame' ||
      session !== guest.session
    ) {
      return
    }
    const episode = owner.episode
    if (!episode) {
      owner.historyMethodUnknown = true
      publish()
      return
    }
    if (
      episode.requestId !== null ||
      !details.frame ||
      details.frame !== episode.frame ||
      episode.url !== navigationUrl(details.url)
    ) {
      episode.ambiguous = true
    }
    episode.requestId = details.id
    episode.method = details.method
  })
  guest.on('did-navigate', committed)
  guest.on('did-start-navigation', navigation)
  guest.on('did-redirect-navigation', redirected)
  return () => {
    stopRequests()
    guest.off('did-navigate', committed)
    guest.off('did-start-navigation', navigation)
    guest.off('did-redirect-navigation', redirected)
  }
}

function navigationUrl(url: string): string {
  return url.split('#', 1)[0]
}
