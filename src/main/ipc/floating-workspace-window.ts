import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  FLOATING_WORKSPACE_WINDOW_CHANNELS as CHANNELS,
  type FloatingWorkspaceWindowSnapshot
} from '../../shared/floating-workspace-window'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { Store } from '../persistence/loading-store/store'
import {
  destroyFloatingWorkspaceWindow,
  getFloatingWorkspaceWindow,
  hideFloatingWorkspaceWindow,
  isFloatingWorkspaceWindowRenderer,
  onFloatingWorkspaceWindowEvent,
  showFloatingWorkspaceWindow
} from '../window/floating-workspace-window'
import { isDashboardPaneKey } from './dashboard-payload-validation'
import { admitFloatingWorkspaceSnapshot } from './floating-workspace-window-payload'
import { isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'

// openMainWindow runs again on macOS activation; the long-lived listeners bind once per store.
let listenersBoundTo: Store | null = null

// Replayed to a window that mounts after a publish; cleared on destroy, kept across hide.
let lastSnapshot: FloatingWorkspaceWindowSnapshot | null = null

/** The only PTY the window may connect to, type into or fit: the last admitted active tab's. */
export function getFloatingWorkspaceAdmittedPtyId(): string | null {
  return lastSnapshot?.activeTab?.ptyId ?? null
}

function isFloatingWorkspaceWindowEnabled(settings: GlobalSettings): boolean {
  return (
    settings.floatingTerminalEnabled === true &&
    settings.experimentalFloatingWorkspacePopout === true
  )
}

export function registerFloatingWorkspaceWindowHandlers(
  store: Store,
  keybindings?: KeybindingService
): void {
  const enabled = (): boolean => isFloatingWorkspaceWindowEnabled(store.getSettings())
  for (const channel of [
    CHANNELS.show,
    CHANNELS.hide,
    CHANNELS.destroy,
    CHANNELS.requestSnapshot
  ]) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of [CHANNELS.publishSnapshot, CHANNELS.requestDock, CHANNELS.ackAgent]) {
    ipcMain.removeAllListeners(channel)
  }

  if (listenersBoundTo !== store) {
    listenersBoundTo = store
    onFloatingWorkspaceWindowEvent((event) => {
      if (event === 'destroyed') {
        lastSnapshot = null
      } else {
        sendToTrustedUIRenderer(CHANNELS.hiddenByUser, null)
      }
    })
    store.onSettingsChanged((updates, settings) => {
      const touched =
        'experimentalFloatingWorkspacePopout' in updates || 'floatingTerminalEnabled' in updates
      if (touched && !isFloatingWorkspaceWindowEnabled(settings)) {
        destroyFloatingWorkspaceWindow()
      }
    })
  }

  ipcMain.handle(CHANNELS.show, (event, args: unknown): void => {
    if (!isTrustedUIRenderer(event.sender) || !enabled()) {
      return
    }
    showFloatingWorkspaceWindow(store, {
      focus: !!args && typeof args === 'object' && 'focus' in args && args.focus === true,
      getKeybindings: () => keybindings?.getOverrides()
    })
  })

  ipcMain.handle(CHANNELS.hide, (event): void => {
    if (isTrustedUIRenderer(event.sender)) {
      hideFloatingWorkspaceWindow()
    }
  })

  ipcMain.handle(CHANNELS.destroy, (event): void => {
    if (isTrustedUIRenderer(event.sender)) {
      destroyFloatingWorkspaceWindow()
    }
  })

  ipcMain.on(CHANNELS.publishSnapshot, (event, snapshot: unknown): void => {
    if (!isTrustedUIRenderer(event.sender) || !enabled()) {
      return
    }
    const admitted = admitFloatingWorkspaceSnapshot(snapshot)
    if (!admitted) {
      console.warn('[floating-workspace-window] rejected malformed snapshot; keeping the previous')
      return
    }
    lastSnapshot = admitted
    getFloatingWorkspaceWindow()?.webContents.send(CHANNELS.snapshot, admitted)
  })

  // Replay immediately, then ask the main renderer for fresh state.
  ipcMain.handle(CHANNELS.requestSnapshot, (event): FloatingWorkspaceWindowSnapshot | null => {
    if (!isFloatingWorkspaceWindowRenderer(event.sender) || !enabled()) {
      return null
    }
    sendToTrustedUIRenderer(CHANNELS.snapshotRequested, null)
    return lastSnapshot
  })

  ipcMain.on(CHANNELS.requestDock, (event): void => {
    if (isFloatingWorkspaceWindowRenderer(event.sender) && enabled()) {
      sendToTrustedUIRenderer(CHANNELS.dockRequested, null)
    }
  })

  ipcMain.on(CHANNELS.ackAgent, (event, args: unknown): void => {
    const ack = args && typeof args === 'object' ? args : {}
    const paneKey = 'paneKey' in ack ? ack.paneKey : undefined
    if (
      !isFloatingWorkspaceWindowRenderer(event.sender) ||
      !enabled() ||
      !isDashboardPaneKey(paneKey) ||
      paneKey !== lastSnapshot?.activeTab?.paneKey
    ) {
      return
    }
    sendToTrustedUIRenderer(CHANNELS.agentAcked, {
      paneKey,
      intent: 'intent' in ack && ack.intent === 'explicit' ? 'explicit' : 'view'
    })
  })
}
