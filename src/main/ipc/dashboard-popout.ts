import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { DashboardSnapshot } from '../../shared/dashboard-snapshot'
import {
  createOrFocusDashboardPopout,
  closeDashboardPopout,
  getDashboardPopoutWindow,
  isDashboardPopoutRenderer,
  onDashboardPopoutOpenChanged
} from '../window/dashboard-popout-window'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { getTrustedUIRendererWindow, isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'
import {
  admitDashboardSnapshot,
  isDashboardPaneKey,
  isDashboardRevealAgentArgs
} from './dashboard-payload-validation'

// The most recent snapshot the main renderer published, replayed to the popout
// the instant it mounts so the board paints without waiting for the next tick.
// Cleared on close so a reopened popout never flashes a previous session.
let lastSnapshot: DashboardSnapshot | null = null

function isDashboardEnabled(store: Store): boolean {
  return store.getSettings().experimentalAgentDashboardPopout === true
}

export function registerDashboardPopoutHandlers(
  store: Store,
  keybindings?: KeybindingService
): void {
  ipcMain.removeHandler('dashboardPopout:open')
  ipcMain.removeHandler('dashboard:publishSnapshot')
  ipcMain.removeHandler('dashboard:requestSnapshot')
  ipcMain.removeHandler('dashboard:getPopoutOpen')
  ipcMain.removeHandler('dashboardPopout:revealAgent')
  ipcMain.removeHandler('dashboardPopout:ackAgent')

  onDashboardPopoutOpenChanged((open) => {
    if (!open) {
      lastSnapshot = null
    }
  })
  store.onSettingsChanged((updates, settings) => {
    if (
      'experimentalAgentDashboardPopout' in updates &&
      settings.experimentalAgentDashboardPopout !== true
    ) {
      lastSnapshot = null
      closeDashboardPopout()
    }
  })

  ipcMain.handle('dashboardPopout:open', (event): void => {
    if (!isTrustedUIRenderer(event.sender) || !isDashboardEnabled(store)) {
      return
    }
    createOrFocusDashboardPopout(store, undefined, {
      getKeybindings: () => keybindings?.getOverrides()
    })
  })

  // Relay: the main renderer publishes derived snapshots; forward to the popout.
  ipcMain.handle('dashboard:publishSnapshot', (event, snapshot: unknown): void => {
    if (!isTrustedUIRenderer(event.sender) || !isDashboardEnabled(store)) {
      return
    }
    const admitted = admitDashboardSnapshot(snapshot)
    // Why: silently dropping left the pop-out replaying a stale board with no
    // trace of why it stopped updating.
    if (!admitted) {
      console.warn('[dashboard] rejected malformed snapshot; pop-out keeps its previous board')
      return
    }
    if (admitted.droppedCardCount > 0) {
      console.warn(`[dashboard] dropped ${admitted.droppedCardCount} invalid card(s) from snapshot`)
    }
    // The renderer omits repoIconsByRepoId once it is unchanged, so carry the
    // last map into the cache — a popout mounting mid-session is replayed this
    // and has no icons of its own to retain. The live popout does, so what is
    // forwarded stays as slim as the renderer sent it.
    lastSnapshot =
      admitted.snapshot.repoIconsByRepoId === undefined && lastSnapshot?.repoIconsByRepoId
        ? { ...admitted.snapshot, repoIconsByRepoId: lastSnapshot.repoIconsByRepoId }
        : admitted.snapshot
    getDashboardPopoutWindow()?.webContents.send('dashboard:snapshot', admitted.snapshot)
  })

  // The popout asks for a snapshot on mount: replay the cache immediately, then
  // nudge the main renderer to publish a fresh one.
  ipcMain.handle('dashboard:requestSnapshot', (event): void => {
    if (!isDashboardPopoutRenderer(event.sender) || !isDashboardEnabled(store)) {
      return
    }
    if (lastSnapshot) {
      event.sender.send('dashboard:snapshot', lastSnapshot)
    }
    sendToTrustedUIRenderer('dashboard:snapshotRequested', null)
  })

  ipcMain.handle('dashboard:getPopoutOpen', (event): boolean =>
    isTrustedUIRenderer(event.sender) && isDashboardEnabled(store)
      ? getDashboardPopoutWindow() !== null
      : false
  )

  // Seen-sync: opening a card's terminal dialog acknowledges the agent in the
  // main renderer's store — the same ack that mutes its sidebar row.
  ipcMain.handle('dashboardPopout:ackAgent', (event, args: unknown): void => {
    if (
      !isDashboardPopoutRenderer(event.sender) ||
      !isDashboardEnabled(store) ||
      !args ||
      typeof args !== 'object' ||
      !isDashboardPaneKey((args as { paneKey?: unknown }).paneKey)
    ) {
      return
    }
    sendToTrustedUIRenderer('ui:ackDashboardAgent', (args as { paneKey: string }).paneKey)
  })

  // Click-to-focus: raise the main window and route it to the agent's pane.
  ipcMain.handle('dashboardPopout:revealAgent', (event, args: unknown): void => {
    if (
      !isDashboardPopoutRenderer(event.sender) ||
      !isDashboardEnabled(store) ||
      !isDashboardRevealAgentArgs(args)
    ) {
      return
    }
    const mainWindow = getTrustedUIRendererWindow()
    if (!mainWindow) {
      return
    }
    safelyRevealWindow(mainWindow)
    mainWindow.webContents.send('ui:revealDashboardAgent', args)
    try {
      app.focus({ steal: true })
    } catch {
      // Best-effort; the per-window focus above may still bring it forward.
    }
  })
}
