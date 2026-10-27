import { ipcMain, Menu, type BrowserWindow } from 'electron'
import { isCrashReportReason } from '../../shared/crash-reporting'
import {
  plainTextContextMenuTargetChannel,
  richMarkdownContextMenuTargetChannel,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import {
  DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
  RendererRecoveryCircuitBreaker
} from '../crash-reporting/renderer-recovery-circuit-breaker'
import { createLowCommitOomRecoveryGate } from '../crash-reporting/low-commit-oom-recovery-gate'
import {
  buildEditableContextMenuTemplate,
  matchingRichMarkdownContextMenuTableTarget,
  parseRichMarkdownContextMenuTableTarget
} from './editable-context-menu'
import type { CreateMainWindowOptions, MainWindowLoadObserver } from './main-window-contracts'
import { browserRouteWebContentsRegistry } from '../browser/browser-route-session-runtime'
import {
  attachBrowserClientPageRenderer,
  retireBrowserClientPageRenderer
} from '../browser/browser-client-page-renderer-runtime'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import { createRendererRecoveryReloadWatchdog } from './renderer-recovery-reload-watchdog'
import { createRendererLaunchFailureBackoff } from './renderer-launch-failure-backoff'
import { trackRendererLivenessAtDeath } from './renderer-liveness-at-death'

export type MainWindowFocusLifecycle = {
  dispose: () => void
  isFloatingPanelFocused: () => boolean
  isFloatingTerminalInputFocused: () => boolean
  isMarkdownEditorFocused: () => boolean
  isRendererProcessGone: () => boolean
  isShortcutRecorderFocused: () => boolean
  isTerminalInputFocused: () => boolean
  /** Relays powerMonitor 'resume' so a suspend-frozen recovery-reload timer does not fire against an unbudgeted load. */
  notifySystemResume: () => void
}

export function installMainWindowFocusLifecycle(args: {
  isWindowClosing: () => boolean
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  reloadMainWindow: (observer: MainWindowLoadObserver) => void
  rendererWebContentsId: number
}): MainWindowFocusLifecycle {
  const { isWindowClosing, mainWindow, opts, reloadMainWindow, rendererWebContentsId } = args
  // Capture once: the BrowserWindow getter throws after close, but late IPC and webContents events can still arrive.
  const rendererWebContents = mainWindow.webContents
  // Mirror TipTap focus before main shortcut resolution so bare Cmd/Ctrl+B remains bold (docs/markdown-cmd-b-bold-design.md).
  let markdownEditorFocused = false
  let terminalInputFocused = false
  // Terminal-input focus selects keybinding context; panel focus is the broader routing owner.
  let floatingTerminalInputFocused = false
  let floatingPanelFocused = false
  let shortcutRecorderFocused = false

  const markdownFocusChannel = 'ui:setMarkdownEditorFocused'
  // Check sender and strict boolean so guests/malformed payloads cannot disable sidebar shortcuts.
  const onMarkdownEditorFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== rendererWebContents) {
      return
    }
    markdownEditorFocused = focused === true
  }
  ipcMain.on(markdownFocusChannel, onMarkdownEditorFocused)
  const terminalInputFocusChannel = 'ui:setTerminalInputFocused'
  // Main resolves before renderer keydown; mirror xterm focus so Terminal-first leaves shell chords alone.
  const onTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== rendererWebContents) {
      return
    }
    terminalInputFocused = focused === true
  }
  ipcMain.on(terminalInputFocusChannel, onTerminalInputFocused)
  const floatingFocusChannel = 'ui:setFloatingFocus'
  // Publish both focus bits atomically; terminal selects keybinding context and implies panel routing ownership.
  const onFloatingFocus = (event: Electron.IpcMainEvent, state: unknown): void => {
    if (event.sender !== rendererWebContents) {
      return
    }
    const payload = (state ?? {}) as { panelFocused?: unknown; terminalFocused?: unknown }
    const terminal = payload.terminalFocused === true
    floatingTerminalInputFocused = terminal
    // Re-assert the invariant defensively in case a sender ever emits panel=false with terminal=true.
    floatingPanelFocused = payload.panelFocused === true || terminal
  }
  ipcMain.on(floatingFocusChannel, onFloatingFocus)
  const shortcutRecorderFocusChannel = 'ui:setShortcutRecorderFocused'
  // Shortcut recording must receive the keys before main consumes their existing bindings.
  const onShortcutRecorderFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== rendererWebContents) {
      return
    }
    shortcutRecorderFocused = focused === true
  }
  ipcMain.on(shortcutRecorderFocusChannel, onShortcutRecorderFocused)

  let pendingRichMarkdownContextMenuTableTarget: RichMarkdownContextMenuTableTarget | null = null
  const onRichMarkdownContextMenuTarget = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== rendererWebContents) {
      return
    }
    pendingRichMarkdownContextMenuTableTarget = parseRichMarkdownContextMenuTableTarget(value)
  }
  ipcMain.on(richMarkdownContextMenuTargetChannel, onRichMarkdownContextMenuTarget)
  // Renderer sends this on the same frame pipe immediately before the next Chromium context menu.
  let pendingPlainTextContextMenuTarget = false
  const onPlainTextContextMenuTarget = (event: Electron.IpcMainEvent): void => {
    if (event.sender === rendererWebContents) {
      pendingPlainTextContextMenuTarget = true
    }
  }
  ipcMain.on(plainTextContextMenuTargetChannel, onPlainTextContextMenuTarget)
  const onMainContextMenu = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    const tableTarget = matchingRichMarkdownContextMenuTableTarget(
      params,
      pendingRichMarkdownContextMenuTableTarget
    )
    const plainText = pendingPlainTextContextMenuTarget
    pendingRichMarkdownContextMenuTableTarget = null
    pendingPlainTextContextMenuTarget = false
    const template = buildEditableContextMenuTemplate(params, rendererWebContents, {
      tableTarget,
      plainText
    })
    if (template.length === 0 || mainWindow.isDestroyed()) {
      return
    }
    // Context menu may precede focus mirroring; trust Electron's editable params.
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: params.x, y: params.y })
  }
  rendererWebContents.on('context-menu', onMainContextMenu)

  // Dead renderers cannot clear focus mirrors; reset carve-outs so later lifecycles retain app shortcuts.
  const resetMarkdownEditorFocus = (): void => {
    markdownEditorFocused = false
    pendingRichMarkdownContextMenuTableTarget = null
    pendingPlainTextContextMenuTarget = false
  }
  const resetTerminalInputFocus = (): void => {
    terminalInputFocused = false
  }
  const resetFloatingTerminalInputFocus = (): void => {
    floatingTerminalInputFocused = false
    floatingPanelFocused = false
  }
  const resetShortcutRecorderFocus = (): void => {
    shortcutRecorderFocused = false
  }
  let rendererProcessGone = false
  registerRendererDocumentNavigation(rendererWebContents, () => {
    const frame = rendererWebContents.mainFrame
    retireBrowserClientPageRenderer(rendererWebContents)
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    return () => {
      if (
        rendererProcessGone ||
        rendererWebContents.isDestroyed() ||
        rendererWebContents.mainFrame !== frame
      ) {
        return
      }
      attachBrowserClientPageRenderer(rendererWebContents)
    }
  })
  let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  // Bound deterministic renderer crash loops with a rolling recovery breaker.
  const rendererRecoveryCircuitBreaker = new RendererRecoveryCircuitBreaker({
    windowMs: DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
    maxRecoveries: DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES
  })
  const launchFailureBackoff = createRendererLaunchFailureBackoff()
  const lowCommitOomGate = createLowCommitOomRecoveryGate()
  const clearRendererRecoveryTimer = (): void => {
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer)
      rendererRecoveryTimer = null
    }
  }
  // A live blank load emits no failure and no renderer death; only the watchdog detects this stall.
  const recoveryReloadWatchdog = createRendererRecoveryReloadWatchdog({
    isRecoveryPending: () => rendererRecoveryTimer !== null,
    isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow,
    rendererWebContentsId
  })
  const scheduleRendererRecovery = (details: Electron.RenderProcessGoneDetails): void => {
    if (
      rendererRecoveryTimer ||
      !details ||
      !isCrashReportReason(details.reason) ||
      isWindowClosing() ||
      opts?.getIsQuitting?.() ||
      opts?.shouldRecoverRenderer?.(details, rendererWebContentsId) === false ||
      mainWindow.isDestroyed()
    ) {
      return
    }
    const launchFailed = details.reason === 'launch-failed'
    const useLaunchBackoff = launchFailed && process.platform !== 'win32'
    const launchRetryDelayMs = useLaunchBackoff ? launchFailureBackoff.nextDelayMs() : null
    const goneAt = Date.now()
    // Read commit at death; the next sampler tick would see memory the dead renderer released.
    const lowCommit = lowCommitOomGate.assess(details, goneAt)
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null
      if (
        isWindowClosing() ||
        opts?.getIsQuitting?.() ||
        opts?.shouldRecoverRenderer?.(details, rendererWebContentsId) === false ||
        mainWindow.isDestroyed()
      ) {
        return
      }
      lowCommitOomGate.recordRecoveredDeath(details, goneAt)
      if (lowCommit) {
        // Reload would OOM again on the starved host; the user must free commit.
        recoveryReloadWatchdog.escalate(
          {
            details,
            recentRecoveryCount: rendererRecoveryCircuitBreaker.recentRecoveryCount(Date.now())
          },
          'low-commit',
          lowCommit
        )
        return
      }
      // Spawn refusal needs its own bounded backoff, independent of crash-loop accounting.
      if (useLaunchBackoff) {
        const subject = { details, recentRecoveryCount: launchFailureBackoff.attempts() }
        if (launchRetryDelayMs === null) {
          recoveryReloadWatchdog.escalate(subject, 'launch-failed')
        } else {
          recoveryReloadWatchdog.issue(details, subject.recentRecoveryCount)
        }
        return
      }
      const recovery = rendererRecoveryCircuitBreaker.registerRecoveryAttempt(Date.now())
      if (!recovery.allowed) {
        // Stop repeated crashes through the one-prompt watchdog; it also watches manual retry so another stall cannot strand a blank window.
        recoveryReloadWatchdog.escalate(
          { details, recentRecoveryCount: recovery.recentRecoveryCount },
          launchFailed ? 'launch-failed' : 'crash-loop'
        )
        return
      }
      // Transient renderer/Network Service loss can blank Chromium; reload the document to recover.
      recoveryReloadWatchdog.issue(details, recovery.recentRecoveryCount)
    }, launchRetryDelayMs ?? 250)
  }
  const rendererLiveness = trackRendererLivenessAtDeath(mainWindow)
  rendererWebContents.on('render-process-gone', (_event, details) => {
    const liveness = rendererLiveness.takeAtRendererGone()
    rendererProcessGone = true
    retireBrowserClientPageRenderer(rendererWebContents)
    browserRouteWebContentsRegistry.retireRenderer(rendererWebContentsId)
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    // macOS reports close teardown as renderer killed/SIGKILL; do not treat window-close noise as a crash.
    if (!isWindowClosing()) {
      // Let the recorder classify crashes so expected-teardown evidence remains reachable.
      opts?.onRendererProcessGone?.(details, rendererWebContentsId, liveness)
    }
    if (!isWindowClosing()) {
      console.error('[window] Renderer process gone; close confirmation will be bypassed', details)
    }
    scheduleRendererRecovery(details)
  })
  rendererWebContents.on('destroyed', () => {
    retireBrowserClientPageRenderer(rendererWebContents)
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
  })
  rendererWebContents.on('did-finish-load', () => {
    rendererProcessGone = false
    attachBrowserClientPageRenderer(rendererWebContents)
    clearRendererRecoveryTimer()
    launchFailureBackoff.reset()
    recoveryReloadWatchdog.notifyDocumentLoaded()
  })

  const dispose = (): void => {
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    clearRendererRecoveryTimer()
    recoveryReloadWatchdog.clear()
    ipcMain.removeListener(markdownFocusChannel, onMarkdownEditorFocused)
    ipcMain.removeListener(terminalInputFocusChannel, onTerminalInputFocused)
    ipcMain.removeListener(floatingFocusChannel, onFloatingFocus)
    ipcMain.removeListener(shortcutRecorderFocusChannel, onShortcutRecorderFocused)
    ipcMain.removeListener(richMarkdownContextMenuTargetChannel, onRichMarkdownContextMenuTarget)
    ipcMain.removeListener(plainTextContextMenuTargetChannel, onPlainTextContextMenuTarget)
  }
  return {
    dispose,
    isFloatingPanelFocused: () => floatingPanelFocused,
    isFloatingTerminalInputFocused: () => floatingTerminalInputFocused,
    isMarkdownEditorFocused: () => markdownEditorFocused,
    isRendererProcessGone: () => rendererProcessGone,
    isShortcutRecorderFocused: () => shortcutRecorderFocused,
    isTerminalInputFocused: () => terminalInputFocused,
    notifySystemResume: recoveryReloadWatchdog.notifySystemResume
  }
}
