import { translateMain } from '../i18n/main-i18n'
import type { BrowserWindow, WebContents } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { KeybindingOverrides } from '../../shared/keybindings/types'
import { createPopoutWindow, revealPopoutWindow } from './popout-window'

// One window per PTY; opening the same PTY again focuses its window.
const windowsByPtyId = new Map<string, BrowserWindow>()

/** The PTY this terminal pop-out was opened for, or null when the sender is not a terminal pop-out. */
export function getTerminalPopoutPtyId(sender: WebContents): string | null {
  for (const [ptyId, window] of windowsByPtyId) {
    if (!window.isDestroyed() && window.webContents === sender) {
      return ptyId
    }
  }
  return null
}

export function openTerminalPopout(
  store: Store | null,
  ptyId: string,
  getKeybindings?: () => KeybindingOverrides | undefined
): void {
  const existing = windowsByPtyId.get(ptyId)
  if (existing && !existing.isDestroyed()) {
    revealPopoutWindow(existing)
    return
  }
  const window = createPopoutWindow(store, {
    getTitle: () => translateMain('native.dialog.terminalPopoutTitle', 'Orca Terminal'),
    partition: 'orca-terminal-popout',
    bounds: { width: 800, height: 520 },
    minWidth: 320,
    minHeight: 200,
    query: { surface: 'terminal', ptyId },
    getKeybindings
  })
  windowsByPtyId.set(ptyId, window)
  window.on('closed', () => {
    if (windowsByPtyId.get(ptyId) === window) {
      windowsByPtyId.delete(ptyId)
    }
  })
}

/** Close with the owning main window so no pop-out outlives it. */
export function closeTerminalPopouts(): void {
  for (const window of windowsByPtyId.values()) {
    if (!window.isDestroyed()) {
      window.close()
    }
  }
  windowsByPtyId.clear()
}
