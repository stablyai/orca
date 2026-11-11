import { ipcMain, type WebContents } from 'electron'

const NATIVE_CHAT_COVER_FOCUS_CHANNEL = 'ui:setNativeChatCoverFocused'

/** Mirrors focus in a terminal pane's native chat cover, whose spatial chords main yields as for a focused xterm. */
export function mirrorNativeChatCoverFocus(rendererWebContents: WebContents): {
  isFocused: () => boolean
  reset: () => void
  dispose: () => void
} {
  let focused = false
  // Check sender and strict boolean so guests/malformed payloads cannot take history chords from main.
  const onFocused = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender === rendererWebContents) {
      focused = value === true
    }
  }
  ipcMain.on(NATIVE_CHAT_COVER_FOCUS_CHANNEL, onFocused)
  return {
    isFocused: () => focused,
    reset: () => {
      focused = false
    },
    dispose: () => {
      focused = false
      ipcMain.removeListener(NATIVE_CHAT_COVER_FOCUS_CHANNEL, onFocused)
    }
  }
}
