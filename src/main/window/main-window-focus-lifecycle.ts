import { ipcMain, Menu, type BrowserWindow } from 'electron'
import { isCrashReportReason } from '../../shared/crash-reporting'
import {
  richMarkdownContextMenuTargetChannel,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import {
  DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
  RendererRecoveryCircuitBreaker
} from '../crash-reporting/renderer-recovery-circuit-breaker'
import {
  buildEditableContextMenuTemplate,
  matchingRichMarkdownContextMenuTableTarget,
  parseRichMarkdownContextMenuTableTarget
} from './editable-context-menu'
import type { CreateMainWindowOptions } from './main-window-contracts'
import { browserRouteWebContentsRegistry } from '../browser/browser-route-session-runtime'
import {
  attachBrowserClientPageRenderer,
  retireBrowserClientPageRenderer
} from '../browser/browser-client-page-renderer-runtime'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import { recoverMainWindowBounds } from './main-window-reachability'

export type MainWindowFocusLifecycle = {
  dispose: () => void
  isFloatingPanelFocused: () => boolean
  isFloatingTerminalInputFocused: () => boolean
  isMarkdownEditorFocused: () => boolean
  isRendererProcessGone: () => boolean
  isShortcutRecorderFocused: () => boolean
  isTerminalInputFocused: () => boolean
}

export function installMainWindowFocusLifecycle(args: {
  isWindowClosing: () => boolean
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  reloadMainWindow: () => void
  rendererWebContentsId: number
}): MainWindowFocusLifecycle {
  const { isWindowClosing, mainWindow, opts, reloadMainWindow, rendererWebContentsId } = args
  // Why: mirror markdown-editor focus so before-input-event skips Cmd/Ctrl+B while TipTap owns focus (docs/markdown-cmd-b-bold-design.md).
  let markdownEditorFocused = false
  let terminalInputFocused = false
  // floatingTerminalInputFocused: textarea-only (terminal keybinding context). floatingPanelFocused: superset for routing ownership.
  let floatingTerminalInputFocused = false
  let floatingPanelFocused = false
  let shortcutRecorderFocused = false

  const markdownFocusChannel = 'ui:setMarkdownEditorFocused'
  // Why: strict-bool + sender check so a guest/webview or malformed IPC payload can't disable the Cmd+B sidebar carve-out.
  const onMarkdownEditorFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    markdownEditorFocused = focused === true
  }
  ipcMain.on(markdownFocusChannel, onMarkdownEditorFocused)
  const terminalInputFocusChannel = 'ui:setTerminalInputFocused'
  // Why: before-input-event resolves shortcuts before renderer keydown; mirror xterm focus so Terminal-first lets shells own app chords.
  const onTerminalInputFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    terminalInputFocused = focused === true
  }
  ipcMain.on(terminalInputFocusChannel, onTerminalInputFocused)
  const floatingFocusChannel = 'ui:setFloatingFocus'
  // Why: one atomic payload for both bits so before-input-event never reads a torn terminal=true/panel=false state.
  // terminalFocused drives the Ctrl+B/L terminal-context carve-out; panelFocused is the routing-ownership superset (panel ⊇ terminal).
  const onFloatingFocus = (event: Electron.IpcMainEvent, state: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
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
  // Why: the Settings recorder must receive app shortcuts to rebind them; before-input-event would otherwise consume the key first.
  const onShortcutRecorderFocused = (event: Electron.IpcMainEvent, focused: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    shortcutRecorderFocused = focused === true
  }
  ipcMain.on(shortcutRecorderFocusChannel, onShortcutRecorderFocused)

  let pendingRichMarkdownContextMenuTableTarget: RichMarkdownContextMenuTableTarget | null = null
  const onRichMarkdownContextMenuTarget = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    pendingRichMarkdownContextMenuTableTarget = parseRichMarkdownContextMenuTableTarget(value)
  }
  ipcMain.on(richMarkdownContextMenuTargetChannel, onRichMarkdownContextMenuTarget)
  const onMainContextMenu = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    const tableTarget = matchingRichMarkdownContextMenuTableTarget(
      params,
      pendingRichMarkdownContextMenuTableTarget
    )
    pendingRichMarkdownContextMenuTableTarget = null
    const template = buildEditableContextMenuTemplate(params, mainWindow.webContents, {
      tableTarget
    })
    if (template.length === 0 || mainWindow.isDestroyed()) {
      return
    }
    // Why: the context-menu event can precede our focus-mirror update; trust Electron's editable params, not markdownEditorFocused.
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: params.x, y: params.y })
  }
  mainWindow.webContents.on('context-menu', onMainContextMenu)

  // Why: a dead renderer can't clear its focus mirror; default-deny carve-outs so it can't disable app shortcuts in a later lifecycle.
  const resetMarkdownEditorFocus = (): void => {
    markdownEditorFocused = false
    pendingRichMarkdownContextMenuTableTarget = null
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
  const rendererWebContents = mainWindow.webContents
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
  // Why: stop a deterministic per-load renderer fault from auto-reloading forever; breaker opens after too many recoveries in a rolling window.
  const rendererRecoveryCircuitBreaker = new RendererRecoveryCircuitBreaker({
    windowMs: DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
    maxRecoveries: DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES
  })
  const clearRendererRecoveryTimer = (): void => {
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer)
      rendererRecoveryTimer = null
    }
  }
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
      const recovery = rendererRecoveryCircuitBreaker.registerRecoveryAttempt(Date.now())
      if (!recovery.allowed) {
        // Why: too many reloads means it will just crash again; stop and let the host surface a recovery prompt.
        opts?.onRendererRecoveryExhausted?.({
          details,
          webContentsId: rendererWebContentsId,
          recentRecoveryCount: recovery.recentRecoveryCount
        })
        return
      }
      // Why: a transient renderer/Network Service loss can blank Chromium; reload the app document once to recover.
      // Why: mark this in-place reload so the did-finish-load orphan sweep spares live PTYs until session restore (#5787).
      opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id)
      recoverMainWindowBounds(mainWindow)
      reloadMainWindow()
    }, 250)
  }
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rendererProcessGone = true
    retireBrowserClientPageRenderer(rendererWebContents)
    browserRouteWebContentsRegistry.retireRenderer(rendererWebContentsId)
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    // Why: macOS reports BrowserWindow teardown as renderer killed/SIGKILL after close — window noise, not a crash.
    if (!isWindowClosing()) {
      // Why: the recorder owns crash classification; filtering here made expected-teardown evidence unreachable.
      opts?.onRendererProcessGone?.(details, rendererWebContentsId)
    }
    if (!isWindowClosing()) {
      console.error('[window] Renderer process gone; close confirmation will be bypassed', details)
    }
    scheduleRendererRecovery(details)
  })
  mainWindow.webContents.on('destroyed', () => {
    retireBrowserClientPageRenderer(rendererWebContents)
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererProcessGone = false
    attachBrowserClientPageRenderer(rendererWebContents)
    clearRendererRecoveryTimer()
  })

  const dispose = (): void => {
    resetMarkdownEditorFocus()
    resetTerminalInputFocus()
    resetFloatingTerminalInputFocus()
    resetShortcutRecorderFocus()
    clearRendererRecoveryTimer()
    ipcMain.removeListener(markdownFocusChannel, onMarkdownEditorFocused)
    ipcMain.removeListener(terminalInputFocusChannel, onTerminalInputFocused)
    ipcMain.removeListener(floatingFocusChannel, onFloatingFocus)
    ipcMain.removeListener(shortcutRecorderFocusChannel, onShortcutRecorderFocused)
    ipcMain.removeListener(richMarkdownContextMenuTargetChannel, onRichMarkdownContextMenuTarget)
  }
  return {
    dispose,
    isFloatingPanelFocused: () => floatingPanelFocused,
    isFloatingTerminalInputFocused: () => floatingTerminalInputFocused,
    isMarkdownEditorFocused: () => markdownEditorFocused,
    isRendererProcessGone: () => rendererProcessGone,
    isShortcutRecorderFocused: () => shortcutRecorderFocused,
    isTerminalInputFocused: () => terminalInputFocused
  }
}
