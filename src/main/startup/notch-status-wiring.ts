import { app, type BrowserWindow, type WebContents } from 'electron'
import { agentHookServer } from '../agent-hooks/server'
import { registerNotchHandlers } from '../ipc/notch'
import { getTrustedUIRendererWindow } from '../ipc/ui'
import { NotchStatusService } from '../notch/notch-status-service'
import {
  NOTCH_QUIT_ABORT_GRACE_MS,
  closeRestoredNotchWithAppWindow,
  shouldRestoreNotchAfterQuitAttempt
} from '../notch/notch-quit-restore'
import { buildNotchRows } from '../notch/notch-rows'
import {
  closeNotchWindow,
  closeNotchWindowForQuit,
  createNotchWindow,
  getNotchWindow,
  setNotchExpanded
} from '../notch/notch-window'
import { findAppWindow } from '../window/app-window-lookup'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import {
  NOTCH_REVEAL_PANE_CHANNEL,
  type NotchFocusPaneRequest
} from '../../shared/notch/notch-snapshot'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { getWorktreePathBasenameFromId } from '../../shared/worktree/id'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { mainProcessState as state } from './main-process-state'

// Why main reads agentHookServer directly: the main window's status IPC detaches when the window
// closes, and the notch exists for exactly that state.
let notchStatusService: NotchStatusService | null = null
let openMainWindow: (() => BrowserWindow) | null = null
// Buffered until the app renderer acks its listener: a freshly opened window drops IPC sent
// before its React effect attaches.
let pendingNotchReveal: NotchFocusPaneRequest | null = null
// The renderer whose listener is attached; the ack waits for session restore and a reload resets it.
let revealReadyContents: WebContents | null = null
let notchQuitCommitted = false
let notchRestorePending = false

function getWorkspaceDisplayName(worktreeId: string): string | null {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'Floating terminal'
  }
  const store = state.store
  return (
    store?.getWorktreeMeta(worktreeId)?.displayName?.trim() ||
    store
      ?.getFolderWorkspaces()
      .find((workspace) => folderWorkspaceKey(workspace.id) === worktreeId)?.name ||
    // Unrenamed checkouts carry no meta name; the sidebar shows their folder too.
    getWorktreePathBasenameFromId(worktreeId)
  )
}

export function syncNotchStatus(showNotchStatus: boolean): void {
  if (process.platform !== 'darwin' || state.isServeMode) {
    return
  }
  if (!showNotchStatus) {
    closeNotchWindow()
    notchStatusService?.stop()
    notchStatusService = null
    return
  }
  if (!notchStatusService) {
    notchStatusService = new NotchStatusService({
      source: agentHookServer,
      getPersistedAcknowledgements: () => state.store?.getUI().acknowledgedAgentsByPaneKey
    })
    notchStatusService.start()
  }
  const service = notchStatusService
  createNotchWindow({
    getSummary: () => service.getSummary(),
    subscribe: (listener) => service.subscribe(listener),
    buildRows: (summary) =>
      buildNotchRows({
        sessions: summary.sessions,
        lookup: { getDisplayName: getWorkspaceDisplayName },
        fallbackTitle: 'Agent'
      })
  })
}

function flushNotchReveal(): void {
  const window = getTrustedUIRendererWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }
  const contents = window.webContents
  if (revealReadyContents !== contents) {
    revealReadyContents = contents
    contents.once('did-start-loading', () => {
      if (revealReadyContents === contents) {
        revealReadyContents = null
      }
    })
  }
  const args = pendingNotchReveal
  pendingNotchReveal = null
  if (args) {
    contents.send(NOTCH_REVEAL_PANE_CHANNEL, args)
  }
}

// Why it reopens a closed window: a row click with no app window is the case the notch exists for.
function revealNotchPane(args: NotchFocusPaneRequest): void {
  const existing = getTrustedUIRendererWindow()
  const window = existing ?? openMainWindow?.()
  if (!window) {
    return
  }
  safelyRevealWindow(window)
  if (existing && revealReadyContents === existing.webContents) {
    existing.webContents.send(NOTCH_REVEAL_PANE_CHANNEL, args)
  } else {
    pendingNotchReveal = args
  }
  if (isBackgroundLaunch()) {
    return
  }
  try {
    app.focus({ steal: true })
  } catch {
    // Best-effort; safelyRevealWindow may still have raised it.
  }
}

// Why on before-quit: an always-on-top window suppresses `window-all-closed`, which completes a
// deferred Cmd+Q. A vetoed quit restores the bar after a grace period.
function installNotchQuitHandlers(): void {
  app.on('will-quit', () => {
    notchQuitCommitted = true
  })
  app.on('before-quit', () => {
    // Why captured per attempt: two vetoed quits inside the grace window must not cancel each other.
    const wasOpen = getNotchWindow() !== null || notchRestorePending
    closeNotchWindowForQuit()
    if (!wasOpen) {
      return
    }
    notchRestorePending = true
    const timer = setTimeout(() => {
      notchRestorePending = false
      const appWindow = findAppWindow()
      if (
        appWindow &&
        shouldRestoreNotchAfterQuitAttempt({
          quitCommitted: notchQuitCommitted,
          hasAppWindow: true,
          settingEnabled: state.store?.getSettings().showNotchStatus === true,
          wasOpenBeforeQuit: wasOpen
        })
      ) {
        syncNotchStatus(true)
        closeRestoredNotchWithAppWindow({
          appWindow,
          isQuitting: () => state.isQuitting,
          closeNotchForQuit: closeNotchWindowForQuit
        })
      }
    }, NOTCH_QUIT_ABORT_GRACE_MS)
    timer.unref?.()
  })
}

/** Installs the notch's IPC and app listeners once, after the main quit handlers. */
export function installNotchStatus(options: { openMainWindow: () => BrowserWindow }): void {
  if (process.platform !== 'darwin') {
    return
  }
  openMainWindow = options.openMainWindow
  registerNotchHandlers({
    getService: () => notchStatusService,
    revealPane: revealNotchPane,
    onRevealRendererReady: flushNotchReveal
  })
  // Why: the panel is non-focusable and never blurs, so close it when attention moves elsewhere.
  app.on('did-resign-active', () => setNotchExpanded(false))
  app.on('browser-window-focus', () => setNotchExpanded(false))
  installNotchQuitHandlers()
}
