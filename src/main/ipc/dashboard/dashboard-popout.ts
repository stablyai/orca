import {
  publishToDocuments,
  removeAppHandler,
  registerAppHandler,
  appDocumentFor
} from '../app-registry/app-handler-registry'
import { app, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import type { DashboardSnapshot } from '../../../shared/agent-status/presentation/dashboard-snapshot'
import {
  createOrFocusDashboardPopout,
  closeDashboardPopout,
  getDashboardPopoutWindow,
  isDashboardPopoutRenderer,
  onDashboardPopoutOpenChanged
} from '../../window/dashboard-popout-window'
import { safelyRevealWindow } from '../../window/activation/focus-existing-window'
import { isBackgroundLaunch } from '../../window/activation/foreground-activation-policy'
import { getTrustedUIRendererWindow, isTrustedUIRenderer, sendToTrustedUIRenderer } from '../ui'
import {
  admitDashboardSnapshot,
  isDashboardPaneKey,
  isDashboardRevealAgentArgs
} from './dashboard-payload-validation'

// Replay immediately on mount; clear on close to avoid showing a previous session.
let lastSnapshot: DashboardSnapshot | null = null

function isDashboardEnabled(store: Store): boolean {
  return store.getSettings().experimentalAgentDashboardPopout === true
}

export function registerDashboardPopoutHandlers(
  store: Store,
  keybindings?: KeybindingService
): void {
  ipcMain.removeHandler('dashboardPopout:open')
  removeAppHandler('dashboard:publishSnapshot')
  removeAppHandler('dashboard:requestSnapshot')
  removeAppHandler('dashboard:getPopoutOpen')
  ipcMain.removeHandler('dashboardPopout:revealAgent')
  removeAppHandler('dashboardPopout:ackAgent')

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
    createOrFocusDashboardPopout(store, {
      getKeybindings: () => keybindings?.getOverrides()
    })
  })

  registerAppHandler('dashboard:publishSnapshot', (event, snapshot: unknown): void => {
    if (event.role !== 'main' || !isDashboardEnabled(store)) {
      return
    }
    const admitted = admitDashboardSnapshot(snapshot)
    // Explain stale replays instead of silently discarding malformed snapshots.
    if (!admitted) {
      console.warn('[dashboard] rejected malformed snapshot; pop-out keeps its previous board')
      return
    }
    if (admitted.droppedCardCount > 0) {
      console.warn(`[dashboard] dropped ${admitted.droppedCardCount} invalid card(s) from snapshot`)
    }
    // Retain omitted unchanged icons for newly mounting popouts; live forwards stay sparse.
    lastSnapshot =
      admitted.snapshot.repoIconsByRepoId === undefined && lastSnapshot?.repoIconsByRepoId
        ? { ...admitted.snapshot, repoIconsByRepoId: lastSnapshot.repoIconsByRepoId }
        : admitted.snapshot
    const popout = getDashboardPopoutWindow()
    if (popout) {
      publishToDocuments('dashboard:snapshot', admitted.snapshot, { windowId: popout.id })
    }
  })

  // Replay immediately, then request fresh renderer state.
  registerAppHandler('dashboard:requestSnapshot', (event): void => {
    if (event.role !== 'dashboard-popout' || !isDashboardEnabled(store)) {
      return
    }
    if (lastSnapshot) {
      publishToDocuments('dashboard:snapshot', lastSnapshot, appDocumentFor(event).caller)
    }
    sendToTrustedUIRenderer('dashboard:snapshotRequested', null)
  })

  registerAppHandler('dashboard:getPopoutOpen', (event): boolean =>
    event.role === 'main' && isDashboardEnabled(store) ? getDashboardPopoutWindow() !== null : false
  )

  // Acknowledge in the main store so popout views also mute sidebar rows.
  registerAppHandler('dashboardPopout:ackAgent', (event, args: unknown): void => {
    const ack = args && typeof args === 'object' ? args : {}
    const paneKey = 'paneKey' in ack ? ack.paneKey : undefined
    if (
      event.role !== 'dashboard-popout' ||
      !isDashboardEnabled(store) ||
      !isDashboardPaneKey(paneKey)
    ) {
      return
    }
    sendToTrustedUIRenderer('ui:ackDashboardAgent', {
      paneKey,
      intent: 'intent' in ack && ack.intent === 'explicit' ? 'explicit' : 'view'
    })
  })

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
    publishToDocuments('ui:revealDashboardAgent', args, { sourceId: mainWindow.webContents.id })
    if (!isBackgroundLaunch()) {
      try {
        app.focus({ steal: true })
      } catch {
        // Best-effort; the per-window focus above may still bring it forward.
      }
    }
  })
}
