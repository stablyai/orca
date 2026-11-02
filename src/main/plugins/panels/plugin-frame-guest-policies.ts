import { BrowserWindow, Menu, webContents as electronWebContents } from 'electron'
import type { Session, WebContents } from 'electron'
import type { KeybindingOverrides } from '../../../shared/keybindings'
import { setupGuestShortcutForwarding } from '../../browser/browser-guest-shortcut-forwarding'
import { buildEditableContextMenuTemplate } from '../../window/editable-context-menu'
import { isAllowedPluginFrameNavigation } from './plugin-frame-request-policy'

/** `did-attach-webview`: per-guest fences the session cannot express, plus Orca's own input. */
export function installPluginFrameGuestPolicies(
  guest: WebContents,
  frameKey: string,
  host: WebContents,
  getKeybindings: () => KeybindingOverrides | undefined
): void {
  // Proxies cannot carry WebRTC UDP; with the refusing proxy no candidate reaches anything.
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  guest.on('will-frame-navigate', (event) => {
    if (!isAllowedPluginFrameNavigation(event.url, frameKey, event.isMainFrame)) {
      event.preventDefault()
    }
  })
  guest.on('will-redirect', (event) => {
    if (!isAllowedPluginFrameNavigation(event.url, frameKey, event.isMainFrame)) {
      event.preventDefault()
    }
  })
  guest.on('will-attach-webview', (event) => event.preventDefault())
  // Web Bluetooth asks the guest, not the session; cancel so the page's promise settles.
  guest.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
  // Why the browser tab path: a focused guest swallows keys, so Orca's shortcuts must be forwarded
  // the same way. Editor save chords are not window shortcuts; they still ride editor.keydown.
  const stopShortcuts = setupGuestShortcutForwarding({
    browserTabId: `plugin-frame:${guest.id}`,
    guest,
    resolveRenderer: () => (host.isDestroyed() ? null : host),
    getKeybindings,
    browserPage: false
  })
  guest.once('destroyed', stopShortcuts)
  guest.on('context-menu', (_event, params) => {
    // Inputs only: Cut/Copy/Paste and spelling, as in Orca's own window. Popup opens at the cursor.
    const template = buildEditableContextMenuTemplate(params, guest, { plainText: true })
    const window = host.isDestroyed() ? null : BrowserWindow.fromWebContents(host)
    if (template.length > 0 && window) {
      Menu.buildFromTemplate(template).popup({ window })
    }
  })
}

/** Closes every live guest on a plugin's partition; the renderer shows its own state after. */
export function closePluginFrameGuests(sess: Session): void {
  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.session === sess && !contents.isDestroyed()) {
      contents.close({ waitForBeforeUnload: false })
    }
  }
}
