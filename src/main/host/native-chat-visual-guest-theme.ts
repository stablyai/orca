import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron'
import {
  NATIVE_CHAT_VISUAL_GUEST_THEME_PUBLISH,
  NATIVE_CHAT_VISUAL_GUEST_THEME_READ,
  NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE,
  nativeChatVisualGuestTheme,
  type NativeChatVisualTheme,
  type NativeChatVisualGuestTheme
} from '../../shared/native-chat/native-chat-visual-shell'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { nativeChatScratchRootFor } from '../native-chat/native-chat-scratch-folder'
import { browserSiteDisplayController } from '../browser/site-settings/browser-site-display-controller'
import { isNativeChatVisualGuestLocation } from '../native-chat/native-chat-visual-guest-location'
import { browserSessionRegistry } from '../browser/sessions/browser-session-registry'
import { localSshBrowserProfileIdForSession } from '../browser/routing/local-host-partitions/local-ssh-browser-partitions'

/** Install before the host loads: an unanswered synchronous preload request blocks its guest. */
export function installNativeChatVisualGuestTheme(window: BrowserWindow): void {
  let theme: NativeChatVisualGuestTheme | null = null
  const guests = new Map<number, WebContents>()
  const watched = new WeakSet<WebContents>()
  const publish = (event: IpcMainEvent, value: NativeChatVisualTheme): void => {
    if (event.sender !== window.webContents) {
      return
    }
    event.returnValue = null
    if (event.senderFrame !== event.sender.mainFrame) {
      return
    }
    if (
      !value ||
      !['light', 'dark'].includes(value.colorScheme) ||
      !value.tokens ||
      Object.values(value.tokens).some((token) => typeof token !== 'string')
    ) {
      return
    }
    const next = nativeChatVisualGuestTheme(value)
    if (next.css === theme?.css && next.colorScheme === theme.colorScheme) {
      return
    }
    theme = next
    for (const guest of guests.values()) {
      if (!guest.isDestroyed()) {
        browserSiteDisplayController.setGuestColorSchemeFallback(guest, theme.colorScheme)
        guest.send(NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE, theme)
      }
    }
  }
  const read = (event: IpcMainEvent): void => {
    const guest = event.sender
    if (guest.hostWebContents !== window.webContents) {
      return
    }
    if (
      !theme ||
      guest.isDestroyed() ||
      guest.getType() !== 'webview' ||
      event.senderFrame !== guest.mainFrame ||
      !isNativeChatVisualGuestLocation(
        event.senderFrame.url,
        nativeChatScratchRootFor(getProfileUserDataPath())
      )
    ) {
      event.returnValue = null
      return
    }
    browserSiteDisplayController.onGuestDocumentStart(guest, {
      url: event.senderFrame.url,
      profileId:
        browserSessionRegistry.profileIdForSession(guest.session) ??
        localSshBrowserProfileIdForSession(guest.session),
      colorScheme: theme.colorScheme
    })
    guests.set(guest.id, guest)
    if (!watched.has(guest)) {
      watched.add(guest)
      guest.on('did-navigate', (_event, url) => {
        if (
          !isNativeChatVisualGuestLocation(url, nativeChatScratchRootFor(getProfileUserDataPath()))
        ) {
          browserSiteDisplayController.setGuestColorSchemeFallback(guest, undefined)
          guests.delete(guest.id)
        } else {
          browserSiteDisplayController.onMainFrameNavigationCommitted(guest.id)
        }
      })
      guest.once('destroyed', () => {
        browserSiteDisplayController.onGuestRetired(guest.id)
        guests.delete(guest.id)
      })
    }
    event.returnValue = theme
  }
  ipcMain.on(NATIVE_CHAT_VISUAL_GUEST_THEME_PUBLISH, publish)
  ipcMain.on(NATIVE_CHAT_VISUAL_GUEST_THEME_READ, read)
  window.webContents.on('destroyed', () => {
    ipcMain.removeListener(NATIVE_CHAT_VISUAL_GUEST_THEME_PUBLISH, publish)
    ipcMain.removeListener(NATIVE_CHAT_VISUAL_GUEST_THEME_READ, read)
    for (const guest of guests.values()) {
      browserSiteDisplayController.setGuestColorSchemeFallback(guest, undefined)
    }
    guests.clear()
  })
}
