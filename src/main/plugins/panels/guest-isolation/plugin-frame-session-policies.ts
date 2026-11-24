import type { Session } from 'electron'
import { isAllowedPluginFrameRequestUrl } from './plugin-frame-request-policy'
import { notePluginFrameBlockedRequest } from './plugin-frame-guest-diagnostics'

/**
 * Session-wide fences for one plugin partition: no network but the plugin's own origin, no
 * permission at all (so no async Clipboard API; `execCommand('copy')` on a gesture still works),
 * no device pickers, no downloads, no spellcheck dictionary fetches.
 */
export function applyPluginFrameSessionPolicies(sess: Session, frameKey: string): void {
  sess.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !isAllowedPluginFrameRequestUrl(details.url, frameKey)
    if (cancel) {
      notePluginFrameBlockedRequest(frameKey, details.url, details.resourceType)
    }
    callback({ cancel })
  })
  sess.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  sess.setPermissionCheckHandler(() => false)
  sess.setDevicePermissionHandler(() => false)
  // Why cancel explicitly: an unanswered chooser request leaves the page's promise hanging.
  sess.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  sess.on('select-serial-port', (event, _ports, _webContents, callback) => {
    event.preventDefault()
    callback('')
  })
  sess.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  sess.on('will-download', (event) => event.preventDefault())
  // Dictionary downloads ride the session's network; plugins get no spellcheck.
  sess.setSpellCheckerEnabled(false)
}
