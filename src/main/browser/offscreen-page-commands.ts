import type { WebContents } from 'electron'
import type { OffscreenPageCommand } from '../../shared/offscreen-page-protocol'

/** Runs a webview-style method call from the renderer element against the page. */
export function runOffscreenPageCommand(
  contents: WebContents,
  command: OffscreenPageCommand
): void {
  switch (command.kind) {
    case 'loadURL':
      void contents.loadURL(command.url).catch(() => {})
      return
    case 'goBack':
      contents.navigationHistory.goBack()
      return
    case 'goForward':
      contents.navigationHistory.goForward()
      return
    case 'reload':
      contents.reload()
      return
    case 'reloadIgnoringCache':
      contents.reloadIgnoringCache()
      return
    case 'stop':
      contents.stop()
      return
    case 'setZoomLevel':
      contents.setZoomLevel(command.level)
      return
    case 'findInPage': {
      // Why drop undefined keys: Electron silently ignores a find whose options carry them.
      const { kind: _kind, text, ...options } = command
      contents.findInPage(
        text,
        Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
      )
      return
    }
    case 'edit':
      contents[command.action]()
      return
    case 'stopFindInPage':
      contents.stopFindInPage(command.action)
  }
}
