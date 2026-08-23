import type { WebContents } from 'electron'
import type { WebContentsTimedFlag } from './web-contents-timed-flag'

export function loadRendererWithPtyRecovery(
  webContents: WebContents,
  recoveryReloadInFlight: WebContentsTimedFlag,
  load: () => void
): void {
  const webContentsId = webContents.id
  let active = true

  function cleanup(): void {
    webContents.removeListener('did-finish-load', onDidFinishLoad)
    webContents.removeListener('did-fail-load', onDidFailLoad)
    webContents.removeListener('destroyed', onDestroyed)
    webContents.removeListener('render-process-gone', onRenderProcessGone)
  }
  function clear(): void {
    if (!active) {
      return
    }
    active = false
    recoveryReloadInFlight.clear(webContentsId)
    cleanup()
  }
  function onDidFinishLoad(): void {
    if (!active) {
      return
    }
    active = false
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
  function onRenderProcessGone(): void {
    clear()
  }

  webContents.on('did-finish-load', onDidFinishLoad)
  webContents.on('did-fail-load', onDidFailLoad)
  webContents.on('destroyed', onDestroyed)
  webContents.on('render-process-gone', onRenderProcessGone)
  recoveryReloadInFlight.mark(webContentsId)
  try {
    load()
  } catch (error) {
    clear()
    throw error
  }
}

export function reloadPromotedControl(
  webContents: WebContents,
  recoveryReloadInFlight: WebContentsTimedFlag
): void {
  loadRendererWithPtyRecovery(webContents, recoveryReloadInFlight, () => webContents.reload())
}
