import type { WebContents } from 'electron'

/** Preload privilege boundary: exact file host/path (query/hash may vary), or same HTTP(S) origin. Broadening this grants foreign pages the Orca bridge. */
export function isRendererDocumentNavigation(currentUrl: string, nextUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextUrl)
    if (current.protocol === 'file:') {
      return (
        next.protocol === 'file:' &&
        next.host === current.host &&
        next.pathname === current.pathname
      )
    }
    return (
      (current.protocol === 'http:' || current.protocol === 'https:') &&
      (next.protocol === 'http:' || next.protocol === 'https:') &&
      next.origin === current.origin
    )
  } catch {
    return false
  }
}

export function registerRendererDocumentNavigation(
  webContents: Pick<WebContents, 'getURL' | 'isLoadingMainFrame' | 'on'>,
  onStarted: () => (() => void) | void
): void {
  let documentGeneration = 0
  let fenceGeneration = 0
  let fenceActive = false
  let cancelReload: (() => void) | null = null
  const restoreSurvivingDocument = (): void => {
    if (
      !fenceActive ||
      fenceGeneration !== documentGeneration ||
      webContents.isLoadingMainFrame()
    ) {
      return
    }
    fenceActive = false
    const cancel = cancelReload
    cancelReload = null
    cancel?.()
  }
  // Blocked external links also emit did-start-loading while the privileged document survives.
  webContents.on('did-start-navigation', (_event, url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument && isRendererDocumentNavigation(webContents.getURL(), url)) {
      if (!fenceActive) {
        fenceActive = true
        fenceGeneration = documentGeneration
        cancelReload = onStarted() ?? null
      }
    }
  })
  webContents.on(
    'did-fail-provisional-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) {
        return
      }
      queueMicrotask(restoreSurvivingDocument)
    }
  )
  webContents.on('will-navigate', (event, _url, _sameDocument, isMainFrame) => {
    if (!isMainFrame) {
      return
    }
    queueMicrotask(() => {
      if (event.defaultPrevented) {
        restoreSurvivingDocument()
      }
    })
  })
  webContents.on('did-stop-loading', restoreSurvivingDocument)
  webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) {
      documentGeneration += 1
      fenceActive = false
      cancelReload = null
    }
  })
}
