import { NotchRemoteSessions } from './notch-remote-sessions'
import { app, type Event } from 'electron'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { mainProcessState as state } from '../startup/main-process-state'
import { focusExistingWindow } from '../startup/main-window/main-window-actions'
import { registerNotchHandlers } from '../ipc/notch'
import { translateMain } from '../i18n/main-i18n'
import {
  NOTCH_REVEAL_PANE_CHANNEL,
  NOTCH_VIEWED_PANES_RESET_CHANNEL,
  type NotchFocusPaneRequest
} from '../../shared/notch/notch-snapshot'
import { NotchStatusService } from './notch-status-service'
import { buildNotchRows } from './notch-rows'
import {
  closeNotchWindow,
  closeNotchWindowForQuit,
  createNotchWindow,
  setNotchExpanded
} from './notch-window'

let service: NotchStatusService | null = null
let remoteSessions: NotchRemoteSessions | null = null
let pendingReveal: NotchFocusPaneRequest | null = null
let readyRendererId: number | null = null

export function clearNotchViewedPanes(): void {
  service?.setViewedPanes([])
  const window = state.mainWindow
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(NOTCH_VIEWED_PANES_RESET_CHANNEL)
  }
}

export function resetNotchRevealReadiness(): void {
  readyRendererId = null
  service?.setViewedPanes([])
}

function deliverPendingReveal(): void {
  const window = state.mainWindow
  if (
    !pendingReveal ||
    !window ||
    window.isDestroyed() ||
    readyRendererId !== window.webContents.id
  ) {
    return
  }
  window.webContents.send(NOTCH_REVEAL_PANE_CHANNEL, pendingReveal)
  pendingReveal = null
}

export function syncNotchAgentStatus(): void {
  if (process.platform !== 'darwin' || state.isServeMode || !service) {
    return
  }
  if (state.isQuitting || state.nativeSettings?.getSettings().showNotchAgentStatus !== true) {
    closeNotchWindow()
    service.stop()
    remoteSessions?.stop()
    return
  }
  service.start()
  remoteSessions?.start()
  createNotchWindow({
    getSummary: () => service!.getSummary(),
    subscribe: (listener) => service!.subscribe(listener),
    buildRows: (summary) =>
      buildNotchRows({
        sessions: summary.sessions,
        lookup: {
          getDisplayName: (id) =>
            state.store?.getWorktreeMeta(id)?.displayName ??
            state.store?.getFolderWorkspace(id)?.name ??
            null
        },
        fallbackTitle: translateMain('notch.agentSession', 'Agent session')
      })
  })
}

export function initializeNotchAgentStatus(): void {
  if (process.platform !== 'darwin' || state.isServeMode || service) {
    return
  }
  const remote = new NotchRemoteSessions()
  remoteSessions = remote
  service = new NotchStatusService({
    acknowledgedCompletions: state.nativeSettings?.getUI().notchAcknowledgedCompletions,
    onAcknowledgedCompletionsChanged: (completions) => {
      void state.nativeSettings
        ?.requestCoreWrite({
          kind: 'ui',
          updates: { notchAcknowledgedCompletions: { ...completions } }
        })
        .catch((error) => console.warn('[notch] Could not persist read completions:', error))
    },
    source: {
      getStatusSnapshot: () => [...agentHookServer.getStatusSnapshot(), ...remote.getRows()],
      subscribeStatusRowMutations: (listener) => {
        const local = agentHookServer.subscribeStatusRowMutations(listener)
        const freshness = agentHookServer.subscribeStatusFreshness(listener)
        const paired = remote.subscribe(listener)
        return () => {
          local()
          freshness()
          paired()
        }
      }
    }
  })
  registerNotchHandlers({
    getService: () => service,
    revealPane: (target) => {
      pendingReveal = target
      deliverPendingReveal()
      focusExistingWindow()
    },
    onRevealRendererReady: () => {
      readyRendererId = state.mainWindow?.webContents.id ?? null
      deliverPendingReveal()
    }
  })
  const collapse = (): void => {
    setNotchExpanded(false)
    clearNotchViewedPanes()
  }
  app.on('browser-window-blur', clearNotchViewedPanes)
  app.on('did-resign-active', collapse)
  app.on('browser-window-focus', collapse)
  const beforeQuit = (event: Event): void => {
    if (!event.defaultPrevented) {
      closeNotchWindowForQuit()
    }
  }
  app.on('before-quit', beforeQuit)
  app.once('will-quit', () => {
    service?.stop()
    remote.stop()
    remoteSessions = null
    service = null
    closeNotchWindowForQuit()
    app.off('browser-window-blur', clearNotchViewedPanes)
    app.off('did-resign-active', collapse)
    app.off('browser-window-focus', collapse)
    app.off('before-quit', beforeQuit)
  })
  syncNotchAgentStatus()
}
