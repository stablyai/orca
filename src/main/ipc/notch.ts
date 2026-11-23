import { app, ipcMain } from 'electron'
import {
  type NotchFocusPaneRequest,
  type NotchCompletionRead,
  NOTCH_ACKNOWLEDGE_CHANNEL,
  NOTCH_VIEWED_PANES_CHANNEL,
  NOTCH_FOCUS_PANE_CHANNEL,
  NOTCH_SET_EXPANDED_CHANNEL,
  NOTCH_RENDERER_READY_CHANNEL,
  NOTCH_SET_INTERACTIVE_CHANNEL
} from '../../shared/notch/notch-snapshot'
import {
  isNotchExpanded,
  isNotchRenderer,
  publishNotchSnapshot,
  setNotchExpanded,
  setNotchInteractive
} from '../notch/notch-window'
import { getTrustedUIRendererWindow } from './ui'
import type { NotchStatusService } from '../notch/notch-status-service'

const MAX_ACK_PANE_KEYS = 512

export type NotchFocusPaneArgs = NotchFocusPaneRequest

function sanitizePaneKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(isNonEmptyString).slice(0, MAX_ACK_PANE_KEYS)
}

function sanitizeCompletionReads(value: unknown): NotchCompletionRead[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, MAX_ACK_PANE_KEYS).flatMap((read) => {
    if (
      typeof read !== 'object' ||
      read === null ||
      !isNonEmptyString(read.paneKey) ||
      typeof read.stateStartedAt !== 'number' ||
      !Number.isFinite(read.stateStartedAt) ||
      typeof read.observedAt !== 'number' ||
      !Number.isFinite(read.observedAt) ||
      (read.turnStartedAt !== undefined &&
        (typeof read.turnStartedAt !== 'number' || !Number.isFinite(read.turnStartedAt)))
    ) {
      return []
    }
    return [
      {
        paneKey: read.paneKey,
        stateStartedAt: read.stateStartedAt,
        observedAt: read.observedAt,
        ...(read.turnStartedAt !== undefined ? { turnStartedAt: read.turnStartedAt } : {})
      }
    ]
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export type NotchHandlerOptions = {
  getService: () => NotchStatusService | null
  /** Raises the app window (reopening it if closed) and routes it to the pane. */
  revealPane: (args: NotchFocusPaneArgs) => void
  /** The app renderer's reveal listener is attached; deliver anything buffered. */
  onRevealRendererReady: () => void
}

export function registerNotchHandlers({
  getService,
  revealPane,
  onRevealRendererReady
}: NotchHandlerOptions): void {
  ipcMain.removeAllListeners('notch:ready')
  ipcMain.on('notch:ready', (event) => {
    if (isNotchRenderer(event.sender) && event.senderFrame === event.sender.mainFrame) {
      publishNotchSnapshot()
    }
  })
  ipcMain.removeAllListeners(NOTCH_VIEWED_PANES_CHANNEL)
  ipcMain.on(NOTCH_VIEWED_PANES_CHANNEL, (event, paneKeys: unknown) => {
    const mainWindow = getTrustedUIRendererWindow()
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) {
      return
    }
    const viewing =
      mainWindow.isVisible() &&
      mainWindow.isFocused() &&
      !mainWindow.isMinimized() &&
      !app.isHidden()
    getService()?.setViewedPanes(viewing ? sanitizePaneKeys(paneKeys) : [])
  })
  ipcMain.removeAllListeners(NOTCH_ACKNOWLEDGE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_SET_EXPANDED_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_FOCUS_PANE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_SET_INTERACTIVE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_RENDERER_READY_CHANNEL)

  ipcMain.on(NOTCH_ACKNOWLEDGE_CHANNEL, (event, paneKeys: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      return
    }
    if (
      !isNotchRenderer(event.sender) &&
      event.sender !== getTrustedUIRendererWindow()?.webContents
    ) {
      return
    }
    const service = getService()
    if (!service) {
      return
    }
    const sanitized = sanitizeCompletionReads(paneKeys)
    if (sanitized.length > 0) {
      service.acknowledgePanes(sanitized)
    }
  })

  // Only the notch's own renderer may drive the window's size.
  ipcMain.on(NOTCH_SET_EXPANDED_CHANNEL, (event, next: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      return
    }
    if (
      isNotchRenderer(event.sender) ||
      (next === false && event.sender === getTrustedUIRendererWindow()?.webContents)
    ) {
      setNotchExpanded(next === 'toggle' ? !isNotchExpanded() : next === true)
    }
  })

  ipcMain.on(NOTCH_SET_INTERACTIVE_CHANNEL, (event, interactive: unknown) => {
    if (event.senderFrame === event.sender.mainFrame && isNotchRenderer(event.sender)) {
      setNotchInteractive(interactive === true)
    }
  })

  ipcMain.on(NOTCH_FOCUS_PANE_CHANNEL, (event, args: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isNotchRenderer(event.sender)) {
      return
    }
    if (!isNonEmptyString(args)) {
      return
    }
    const row = getService()
      ?.getSummary()
      .sessions.find((session) => session.paneKey === args)
    if (row?.worktreeId && row.tabId) {
      revealPane({
        paneKey: row.paneKey,
        worktreeId: row.worktreeId,
        tabId: row.tabId,
        leafId: row.leafId,
        sessionId: row.sessionId,
        executionHostId: row.executionHostId
      })
    }
  })

  ipcMain.on(NOTCH_RENDERER_READY_CHANNEL, (event) => {
    if (
      event.senderFrame === event.sender.mainFrame &&
      event.sender === getTrustedUIRendererWindow()?.webContents
    ) {
      onRevealRendererReady()
    }
  })
}
