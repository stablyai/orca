import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import {
  normalizeTerminalShortcutPolicy,
  type KeybindingMatchOptions
} from '../../shared/keybindings'
import {
  getWindowShortcutActionId,
  matchesRecentTabSwitcherChord,
  nativeZoomCommandMatchesKeybindings,
  resolveWindowShortcutAction,
  windowShortcutActionCapturesTerminal,
  type WindowShortcutAction
} from '../../shared/window-shortcut-policy'
import type { Store } from '../persistence'
import type { CreateMainWindowOptions } from './main-window-contracts'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import { sendResolvedWindowShortcutAction } from './main-window-shortcut-actions'
import { isMacAppPasteInput } from './mac-app-paste-input'

export function installMainWindowShortcutRouting(args: {
  focus: MainWindowFocusLifecycle
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  store: Store | null
}): void {
  const { focus, mainWindow, opts, store } = args
  const doubleTapDetector = new ModifierDoubleTapDetector()

  const dispatchResolvedWindowShortcutAction = (
    event: Electron.Event,
    action: WindowShortcutAction,
    options: {
      isAutoRepeat: boolean
      focusedShortcutContext: KeybindingMatchOptions
    }
  ): boolean => {
    const { focusedShortcutContext, isAutoRepeat } = options
    if (
      focus.isFloatingTerminalInputFocused() &&
      (action.type === 'toggleLeftSidebar' || action.type === 'toggleRightSidebar')
    ) {
      return false
    }

    const isIndexJump = action.type === 'jumpToWorktreeIndex' || action.type === 'jumpToTabIndex'
    if (isIndexJump && isAutoRepeat) {
      // Renderer index handlers skip repeats; contain them here or raw keys leak to xterm/DOM.
      event.preventDefault()
      return true
    }

    // Floating-panel ownership routes index jumps to its renderer tabs instead of the main workspace.
    if (focus.isFloatingPanelFocused() && isIndexJump) {
      return false
    }

    const capturedTerminalActionId =
      focusedShortcutContext.context === 'terminal' &&
      focusedShortcutContext.terminalShortcutPolicy === 'orca-first' &&
      windowShortcutActionCapturesTerminal(action)
        ? getWindowShortcutActionId(action)
        : null

    // Hold dictation needs renderer keyup; consume only single-keydown toggles in main.
    if (action.type === 'dictationKeyDown') {
      const voiceSettings = store?.getSettings().voice
      if (!voiceSettings?.enabled || !voiceSettings.sttModel) {
        return false
      }
      const dictationMode = voiceSettings.dictationMode ?? 'toggle'
      if (dictationMode === 'hold') {
        return false
      }
      if (isAutoRepeat) {
        event.preventDefault()
        return true
      }
      event.preventDefault()
      if (capturedTerminalActionId) {
        mainWindow.webContents.send('ui:terminalShortcutCaptured', {
          actionId: capturedTerminalActionId
        })
      }
      mainWindow.webContents.send('ui:dictationKeyDown')
      return true
    }

    if (
      (action.type === 'toggleQuickCommandsMenu' || action.type === 'deleteCurrentWorkspace') &&
      isAutoRepeat
    ) {
      event.preventDefault()
      return true
    }

    event.preventDefault()
    if (capturedTerminalActionId) {
      mainWindow.webContents.send('ui:terminalShortcutCaptured', {
        actionId: capturedTerminalActionId
      })
    }

    sendResolvedWindowShortcutAction(mainWindow, action, opts?.onBeforeReload)
    return true
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (focus.isShortcutRecorderFocused()) {
      return
    }

    if (input.type === 'keyDown' && !app.isPackaged && input.code === 'F12') {
      event.preventDefault()
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
      return
    }

    if (isMacAppPasteInput(input)) {
      // Chat/terminal panes are not native editable controls; route Cmd+V through Orca paste ownership.
      event.preventDefault()
      mainWindow.webContents.send('ui:appMenuPaste')
      return
    }

    const keybindings = opts?.getKeybindings?.()
    const terminalShortcutContext: KeybindingMatchOptions = {
      context:
        focus.isTerminalInputFocused() || focus.isFloatingTerminalInputFocused()
          ? 'terminal'
          : 'app',
      terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
        store?.getSettings().terminalShortcutPolicy
      )
    }
    const appShortcutContext: KeybindingMatchOptions = {
      context: 'app',
      terminalShortcutPolicy: terminalShortcutContext.terminalShortcutPolicy
    }

    // Bare modifiers emit no terminal bytes, so raw-stream double taps cannot steal readline input.
    if (input.type === 'keyDown' || input.type === 'keyUp') {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: input.type,
          code: input.code,
          key: input.key,
          shift: input.shift,
          control: input.control,
          alt: input.alt,
          meta: input.meta,
          isAutoRepeat: input.isAutoRepeat
        }),
        Date.now()
      )
      if (detected) {
        const doubleTapAction = resolveWindowShortcutAction(
          { type: 'keyDown', doubleTapModifier: detected.modifier },
          process.platform,
          keybindings,
          appShortcutContext
        )
        if (
          doubleTapAction &&
          dispatchResolvedWindowShortcutAction(event, doubleTapAction, {
            isAutoRepeat: false,
            focusedShortcutContext: terminalShortcutContext
          })
        ) {
          // preventDefault only the emitting keydown so the renderer detector can't also fire for the same gesture.
          return
        }
        // No allowlisted action: let the keydown reach the renderer, whose detector completes and dispatches inline.
      }
    }

    if (
      input.type === 'keyDown' &&
      matchesRecentTabSwitcherChord(input, process.platform, keybindings, terminalShortcutContext)
    ) {
      // Held switchers commit on modifier keyup; preventing keydown can suppress it and strand the overlay.
      return
    }

    // TipTap owns bare Cmd/Ctrl+B only; preserve modifier variants (docs/markdown-cmd-b-bold-design.md).
    const modForBold = process.platform === 'darwin' ? input.meta : input.control
    if (
      focus.isMarkdownEditorFocused() &&
      input.code === 'KeyB' &&
      !input.alt &&
      !input.shift &&
      modForBold
    ) {
      return
    }

    // Allowlist interception so readline control chords reach the PTY.
    const action = resolveWindowShortcutAction(
      input,
      process.platform,
      keybindings,
      terminalShortcutContext
    )
    if (!action) {
      return
    }

    if (input.type !== 'keyDown') {
      return
    }

    dispatchResolvedWindowShortcutAction(event, action, {
      isAutoRepeat: Boolean(input.isAutoRepeat),
      focusedShortcutContext: terminalShortcutContext
    })
  })

  // Reset on focus loss or the next modifier could complete a phantom double tap.
  mainWindow.on('blur', () => doubleTapDetector.reset())

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Some layouts emit only Electron zoom commands; honor them only while bound.
    if (zoomDirection !== 'in' && zoomDirection !== 'out') {
      return
    }
    if (
      !nativeZoomCommandMatchesKeybindings(
        zoomDirection,
        process.platform,
        opts?.getKeybindings?.(),
        {
          context:
            focus.isTerminalInputFocused() || focus.isFloatingTerminalInputFocused()
              ? 'terminal'
              : 'app',
          terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
            store?.getSettings().terminalShortcutPolicy
          )
        }
      )
    ) {
      return
    }
    event.preventDefault()
    mainWindow.webContents.send('terminal:zoom', zoomDirection)
  })
}
