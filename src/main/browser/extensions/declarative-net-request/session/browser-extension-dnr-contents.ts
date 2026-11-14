import { webFrameMain } from 'electron'
import { getDnrSessionRuntime } from './browser-extension-dnr-session'

/** Frame commits and lifetime of one tab (or popout) webContents in an extension session. */
export function observeBrowserExtensionDnrContents(contents: Electron.WebContents): void {
  const { id, session } = contents
  contents.on(
    'did-frame-navigate',
    (_event, url, _code, _status, _isMainFrame, processId, routingId) => {
      const runtime = getDnrSessionRuntime(session)
      const frame = runtime ? webFrameMain.fromId(processId, routingId) : undefined
      if (runtime && frame && !frame.isDestroyed()) {
        runtime.frames.commit(runtime.inUse ? runtime.engine : null, id, frame, url)
      }
    }
  )
  // Why after tabs-lifecycle's handler: that one resets the tab's badge for the new document.
  contents.on('did-navigate', () => getDnrSessionRuntime(session)?.matched.commitNavigation(id))
  contents.on('did-stop-loading', () =>
    getDnrSessionRuntime(session)?.matched.finishNavigations(id)
  )
  contents.once('destroyed', () => {
    getDnrSessionRuntime(session)?.frames.forgetContents(id)
    getDnrSessionRuntime(session)?.matched.forgetTab(id)
  })
}
