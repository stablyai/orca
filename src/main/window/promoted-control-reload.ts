import type { WebContents } from 'electron'
import type { WebContentsTimedFlag } from './web-contents-timed-flag'

export function reloadPromotedControl(
  webContents: WebContents,
  recoveryReloadInFlight: WebContentsTimedFlag
): void {
  const webContentsId = webContents.id

  function cleanup(): void {
    webContents.removeListener('did-finish-load', onDidFinishLoad)
    webContents.removeListener('did-fail-load', onDidFailLoad)
    webContents.removeListener('destroyed', onDestroyed)
  }
  function clear(): void {
    recoveryReloadInFlight.clear(webContentsId)
    cleanup()
  }
  function onDidFinishLoad(): void {
    cleanup()
  }
  function onDidFailLoad(
    _event: unknown,
    _errorCode: number,
    _errorDescription: string,
    _validatedUrl: string,
    isMainFrame: boolean,
    _frameProcessId: number,
    _frameRoutingId: number
  ): void {
    if (isMainFrame) {
      clear()
    }
  }
  function onDestroyed(): void {
    clear()
  }

  webContents.on('did-finish-load', onDidFinishLoad)
  webContents.on('did-fail-load', onDidFailLoad)
  webContents.on('destroyed', onDestroyed)
  recoveryReloadInFlight.mark(webContentsId)
  try {
    webContents.reload()
  } catch (error) {
    clear()
    throw error
  }
}
