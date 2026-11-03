import type { IpcRenderer, WebFrame } from 'electron'
import {
  NATIVE_CHAT_VISUAL_GUEST_THEME_READ,
  NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE,
  type NativeChatVisualGuestTheme
} from '../shared/native-chat/native-chat-visual-shell'

export function installNativeChatVisualGuestTheme(
  ipc: Pick<IpcRenderer, 'sendSync' | 'on'>,
  frame: Pick<WebFrame, 'insertCSS' | 'removeInsertedCSS'>
): void {
  if (!process.isMainFrame || !/^(file:|orca-preview:)/.test(globalThis.location?.href ?? '')) {
    return
  }
  const initial: NativeChatVisualGuestTheme | null = ipc.sendSync(
    NATIVE_CHAT_VISUAL_GUEST_THEME_READ
  )
  if (!initial) {
    return
  }
  let theme = initial
  let key = frame.insertCSS(theme.css, { cssOrigin: 'user' })
  const updateRoot = (): boolean => {
    if (!document.documentElement) {
      return false
    }
    document.documentElement.classList.toggle('dark', theme.colorScheme === 'dark')
    return true
  }
  if (!updateRoot()) {
    const observer = new MutationObserver(() => {
      if (updateRoot()) {
        observer.disconnect()
      }
    })
    observer.observe(document, { childList: true })
  }
  ipc.on(NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE, (_event, next: NativeChatVisualGuestTheme) => {
    theme = next
    frame.removeInsertedCSS(key)
    key = frame.insertCSS(theme.css, { cssOrigin: 'user' })
    updateRoot()
  })
}
