import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
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
  isDashboardPaneKey,
  isDashboardRevealAgentArgs,
  isDashboardSnapshot
} from './dashboard-payload-validation'

// The most recent snapshot the main renderer published, replayed to the popout
// the instant it mounts so the board paints without waiting for the next tick.
// Cleared on close so a reopened popout never flashes a previous session.
let lastSnapshot: DashboardSnapshot | null = null

function isDashboardEnabled(store: Store): boolean {
  return store.getSettings().experimentalAgentDashboardPopout === true
}

export function registerDashboardPopoutHandlers(store: Store): void {
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
    createOrFocusDashboardPopout(store)
  })

  // Relay: the main renderer publishes derived snapshots; forward to the popout.
  ipcMain.handle('dashboard:publishSnapshot', (event, snapshot: unknown): void => {
    if (
      !isTrustedUIRenderer(event.sender) ||
      !isDashboardEnabled(store) ||
      !isDashboardSnapshot(snapshot)
    ) {
      return
    }
    lastSnapshot = snapshot
    getDashboardPopoutWindow()?.webContents.send('dashboard:snapshot', snapshot)
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
