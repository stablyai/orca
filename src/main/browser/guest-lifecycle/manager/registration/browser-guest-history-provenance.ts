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
    completed: boolean
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
      const ambiguous = Boolean(previous && (!previous.completed || !previous.committed))
      if (ambiguous) {
        owner.historyMethodUnknown = true
      }
      owner.episode = {
        url: navigationUrl(details.url),
        frame: details.frame,
        requestId: null,
        method: null,
        committed: false,
        completed: false,
        ambiguous
      }
      owner.knownGet = false
      owner.navigating = true
      invalidate()
    } else if (!details.isMainFrame) {
      publish()
    }
  }
  const certify = (): void => {
    const episode = owner.episode
    if (!episode?.committed || !episode.completed) {
      return
    }
    owner.knownGet = !episode.ambiguous && episode.method === 'GET'
    if (!owner.knownGet) {
      owner.historyMethodUnknown = true
    }
    rederiveSoleHistory()
    publish()
  }
  const committed = (_event: Electron.Event, url: string): void => {
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
    certify()
  }
  const stopRequests = observeBrowserGuestRequests(guest.id, (session, event, details) => {
    if (details.resourceType !== 'mainFrame' || session !== guest.session) {
      return
    }
    const episode = owner.episode
    if (!episode) {
      owner.historyMethodUnknown = true
      publish()
      return
    }
    if (event === 'onBeforeRequest') {
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
    } else if (event === 'onBeforeRedirect' || event === 'onErrorOccurred') {
      episode.ambiguous = true
      owner.historyMethodUnknown = true
    } else if (event === 'onCompleted') {
      if (
        episode.requestId !== details.id ||
        episode.url !== navigationUrl(details.url) ||
        (details.statusCode !== undefined && details.statusCode >= 400)
      ) {
        episode.ambiguous = true
      }
      episode.completed = true
      certify()
    }
  })
  guest.on('did-navigate', committed)
  guest.on('did-start-navigation', navigation)
  return () => {
    stopRequests()
    guest.off('did-navigate', committed)
    guest.off('did-start-navigation', navigation)
  }
}

function navigationUrl(url: string): string {
  return url.split('#', 1)[0]
}
