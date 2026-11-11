import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import type { BrowserGuestMetadata } from '../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import { readGuestNavigationState } from './browser-guest-navigation-state'
import { isChromiumInternalErrorUrl } from '../manager/navigation/browser-main-frame-navigation'

const projections = new WeakMap<
  Electron.WebContents,
  {
    read: () => BrowserGuestMetadata | null
    publish: () => void
  }
>()

export function readBrowserGuestMetadata(guest: Electron.WebContents): BrowserGuestMetadata | null {
  return projections.get(guest)?.read() ?? null
}

export function publishBrowserGuestMetadata(guest: Electron.WebContents): void {
  projections.get(guest)?.publish()
}

export function installBrowserGuestMetadata({
  guest,
  resolveOwner,
  readLoadError,
  hasCertificateFailure,
  reportErrorPage,
  send
}: {
  guest: Electron.WebContents
  resolveOwner: () => string | undefined
  readLoadError: () => BrowserLoadError | null
  hasCertificateFailure: () => boolean
  reportErrorPage: () => void
  send: (state: BrowserGuestMetadata) => void
}): () => void {
  let revision = 0
  let navigationRevision = 0
  let committedUrl = isChromiumInternalErrorUrl(guest.getURL()) ? '' : guest.getURL()
  let title = committedUrl ? guest.getTitle() : ''
  let loading = guest.isLoadingMainFrame()
  let previous: BrowserGuestMetadata | null = null
  const read = (kind: BrowserGuestMetadata['kind'] = 'snapshot'): BrowserGuestMetadata | null => {
    const browserPageId = resolveOwner()
    if (!browserPageId || guest.isDestroyed()) {
      return null
    }
    const errorPage = isChromiumInternalErrorUrl(guest.getURL())
    return {
      browserPageId,
      webContentsId: guest.id,
      revision,
      navigationRevision,
      kind,
      url: committedUrl,
      title,
      loading,
      errorPage,
      loadError: readLoadError(),
      hasCertificateFailure: hasCertificateFailure(),
      ...readGuestNavigationState(guest)
    }
  }
  const publish = (kind: BrowserGuestMetadata['kind'] = 'snapshot'): void => {
    const next = read(kind)
    if (!next) {
      return
    }
    if (
      previous &&
      kind !== 'snapshot' &&
      kind !== 'stop' &&
      kind !== 'failure' &&
      next.browserPageId === previous.browserPageId &&
      next.url === previous.url &&
      next.title === previous.title &&
      next.loading === previous.loading &&
      next.errorPage === previous.errorPage &&
      next.loadError === previous.loadError &&
      next.hasCertificateFailure === previous.hasCertificateFailure &&
      next.canGoBack === previous.canGoBack &&
      next.canGoForward === previous.canGoForward &&
      next.navigationRevision === previous.navigationRevision
    ) {
      return
    }
    next.revision = ++revision
    previous = next
    send(next)
  }
  const onNavigate = (_event: Electron.Event, url: string): void => {
    if (isChromiumInternalErrorUrl(url)) {
      return
    }
    committedUrl = url
    title = guest.getTitle()
    navigationRevision++
    publish('navigation')
  }
  const onInPage = (_event: Electron.Event, url: string, isMainFrame: boolean): void => {
    if (!isMainFrame || isChromiumInternalErrorUrl(url)) {
      return
    }
    committedUrl = url
    title = guest.getTitle()
    navigationRevision++
    publish('in-page')
  }
  const onTitle = (_event: Electron.Event, nextTitle: string): void => {
    if (isChromiumInternalErrorUrl(guest.getURL())) {
      return
    }
    title = nextTitle
    publish('title')
  }
  const onStart = (
    _event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame || isInPlace || isChromiumInternalErrorUrl(url)) {
      return
    }
    loading = true
    publish('start')
  }
  const onStop = (): void => {
    if (
      isChromiumInternalErrorUrl(guest.getURL()) &&
      !readLoadError() &&
      !hasCertificateFailure()
    ) {
      reportErrorPage()
    }
    loading = false
    publish('stop')
  }
  const onFail = (
    _event: Electron.Event,
    code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame || code === -3) {
      return
    }
    loading = false
    publish('failure')
  }
  projections.set(guest, { read: () => read(), publish: () => publish() })
  guest.on('did-navigate', onNavigate)
  guest.on('did-navigate-in-page', onInPage)
  guest.on('page-title-updated', onTitle)
  guest.on('did-start-navigation', onStart)
  guest.on('did-stop-loading', onStop)
  guest.on('did-fail-load', onFail)
  return () => {
    if (previous) {
      send({ ...previous, revision: ++revision, kind: 'retired', loading: false })
    }
    projections.delete(guest)
    guest.off('did-navigate', onNavigate)
    guest.off('did-navigate-in-page', onInPage)
    guest.off('page-title-updated', onTitle)
    guest.off('did-start-navigation', onStart)
    guest.off('did-stop-loading', onStop)
    guest.off('did-fail-load', onFail)
  }
}
