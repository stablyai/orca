import type { WebContents } from 'electron'

/**
 * True when the target stays inside the window's own privileged document: for `file:`
 * the exact same host+path (query/hash may differ, as a reload keeps them), for http(s)
 * the same origin. Also gates preload privilege in installPrivilegedWindowNavigationPolicy,
 * so loosening it past a same-origin document hands a foreign page the Orca bridge.
 */
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
  // Why: did-start-loading also fires for blocked external links whose renderer document survives.
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
