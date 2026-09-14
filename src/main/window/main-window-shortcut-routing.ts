import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
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
import { isMacAppPasteInput } from './main-window-visual-lifecycle'

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
      // Contain held-key repeats in main — every renderer index path skips e.repeat, so yielding a
      // repeat would leak a raw key to xterm/DOM, and re-firing the jump is never what a hold means.
      event.preventDefault()
      return true
    }

    // While the floating panel owns the keyboard, yield indexed switch chords to the renderer
    // so L2 selects a floating tab instead of switching the main workspace behind the panel.
    if (focus.isFloatingPanelFocused() && isIndexJump) {
      return false
    }

    const capturedTerminalActionId =
      focusedShortcutContext.context === 'terminal' &&
      focusedShortcutContext.terminalShortcutPolicy === 'orca-first' &&
      windowShortcutActionCapturesTerminal(action)
        ? getWindowShortcutActionId(action)
        : null

    // Why: hold-mode dictation needs renderer keyup events, so main only consumes single-keydown dictation toggles.
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

    if (input.type === 'keyDown' && is.dev && input.code === 'F12') {
      event.preventDefault()
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
      return
    }

    if (isMacAppPasteInput(input)) {
      // Why: chat/terminal panes hold focus without native editable controls, so route Cmd+V through Orca's paste ownership.
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

    // Why: bare modifiers emit no terminal bytes, so double-tap detection on the raw key stream never steals readline input.
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
      // Why: the held switcher commits on modifier keyup; preventing the keydown here can suppress the keyup and strand the overlay.
      return
    }

    // Why: TipTap owns bare Cmd/Ctrl+B for bold in the markdown editor; skip interception for the bare chord only.
    // See docs/markdown-cmd-b-bold-design.md.
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

    // Why: keep interception an explicit allowlist so readline control chords reach the PTY instead of being silently stolen.
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

  // Why: mid-gesture focus loss must not leave the detector armed, or the next modifier press completes a phantom double-tap.
  mainWindow.on('blur', () => doubleTapDetector.reset())

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // Why: some layouts fire Electron's zoom command without before-input-event; honor it only while the zoom action is still bound.
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
