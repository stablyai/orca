import { ipcMain } from 'electron'
import {
  NOTCH_ACKNOWLEDGE_CHANNEL,
  NOTCH_FOCUS_PANE_CHANNEL,
  NOTCH_SET_EXPANDED_CHANNEL,
  NOTCH_RENDERER_READY_CHANNEL,
  NOTCH_SET_INTERACTIVE_CHANNEL
} from '../../shared/notch/notch-snapshot'
import { isNotchRenderer, setNotchExpanded, setNotchInteractive } from '../notch/notch-window'
import { getTrustedUIRendererWindow } from './ui'
import type { NotchStatusService } from '../notch/notch-status-service'

// Why: pane keys arrive from a renderer, so they are treated as untrusted — a malformed or
// unbounded payload must not grow main's acknowledgement map.
const MAX_ACK_PANE_KEYS = 512

export type NotchFocusPaneArgs = {
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
}

function sanitizePaneKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  // Why isNonEmptyString and not a bare length check: it also caps each key, so a renderer
  // cannot satisfy the count bound with 512 multi-megabyte strings.
  return value.filter(isNonEmptyString).slice(0, MAX_ACK_PANE_KEYS)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function parseFocusPaneArgs(value: unknown): NotchFocusPaneArgs | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const args = value as Record<string, unknown>
  if (
    !isNonEmptyString(args.repoId) ||
    !isNonEmptyString(args.worktreeId) ||
    !isNonEmptyString(args.tabId)
  ) {
    return null
  }
  return {
    repoId: args.repoId,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: isNonEmptyString(args.leafId) ? args.leafId : null
  }
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
  // Why: openMainWindow() runs again on dock re-activation and on a notch row click, so without
  // this every reopen would stack another listener — one ack becoming N acks, one row click
  // becoming N reveals. Mirrors the removeHandler prologue in ipc/dashboard-popout.ts.
  ipcMain.removeAllListeners(NOTCH_ACKNOWLEDGE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_SET_EXPANDED_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_FOCUS_PANE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_SET_INTERACTIVE_CHANNEL)
  ipcMain.removeAllListeners(NOTCH_RENDERER_READY_CHANNEL)

  ipcMain.on(NOTCH_ACKNOWLEDGE_CHANNEL, (event, paneKeys: unknown) => {
    // Why this check differs from the other three channels: acknowledgement has two legitimate
    // senders — the notch renderer (clicking a row) and the main window (visiting a pane, via
    // acknowledgeAgents in store/slices/ui.ts). Gating on isNotchRenderer alone would silently
    // break the visit-clears-the-finished-lane rule, which is the whole retention model.
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
    const sanitized = sanitizePaneKeys(paneKeys)
    if (sanitized.length > 0) {
      service.acknowledgePanes(sanitized, Date.now())
    }
  })

  // Only the notch's own renderer may drive the window's size.
  ipcMain.on(NOTCH_SET_EXPANDED_CHANNEL, (event, next: unknown) => {
    if (isNotchRenderer(event.sender)) {
      setNotchExpanded(next === true)
    }
  })

  ipcMain.on(NOTCH_SET_INTERACTIVE_CHANNEL, (event, interactive: unknown) => {
    if (isNotchRenderer(event.sender)) {
      setNotchInteractive(interactive === true)
    }
  })

  ipcMain.on(NOTCH_FOCUS_PANE_CHANNEL, (event, args: unknown) => {
    if (!isNotchRenderer(event.sender)) {
      return
    }
    const parsed = parseFocusPaneArgs(args)
    if (parsed) {
      revealPane(parsed)
    }
  })

  ipcMain.on(NOTCH_RENDERER_READY_CHANNEL, (event) => {
    if (event.sender === getTrustedUIRendererWindow()?.webContents) {
      onRevealRendererReady()
    }
  })
}
