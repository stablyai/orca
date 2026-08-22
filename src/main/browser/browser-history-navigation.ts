const HISTORY_NAVIGATION_SETTLE_TIMEOUT_MS = 10_000

type BrowserHistoryDirection = 'back' | 'forward'
export type BrowserHistoryNavigationResult = 'navigated' | 'replaced'

export async function waitForBrowserHistoryNavigation(
  webContents: Electron.WebContents,
  direction: BrowserHistoryDirection
): Promise<BrowserHistoryNavigationResult> {
  const history = webContents.navigationHistory
  const canNavigate = direction === 'back' ? history.canGoBack() : history.canGoForward()
  if (!canNavigate) {
    return 'navigated'
  }

  return new Promise<BrowserHistoryNavigationResult>((resolve, reject) => {
    let settled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      webContents.removeListener('did-navigate', onNavigate)
      webContents.removeListener('did-navigate-in-page', onNavigateInPage)
      webContents.removeListener('did-fail-load', onFailLoad)
      webContents.removeListener('destroyed', onDestroyed)
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
      }
    }
    const finish = (result: BrowserHistoryNavigationResult = 'navigated'): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }

    const onNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) {
        finish()
      }
    }
    const onNavigate = (): void => finish()
    const onFailLoad = (
      _event: Electron.Event,
      _errorCode: number,
      _errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame) {
        finish()
      }
    }
    const onDestroyed = (): void => finish('replaced')

    webContents.on('did-navigate', onNavigate)
    webContents.on('did-navigate-in-page', onNavigateInPage)
    webContents.on('did-fail-load', onFailLoad)
    webContents.on('destroyed', onDestroyed)
    fallbackTimer = setTimeout(finish, HISTORY_NAVIGATION_SETTLE_TIMEOUT_MS)
    fallbackTimer.unref?.()
    try {
      if (direction === 'back') {
        history.goBack()
      } else {
        history.goForward()
      }
    } catch (error) {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
  })
}
