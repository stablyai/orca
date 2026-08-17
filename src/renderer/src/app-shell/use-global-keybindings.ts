import { useEffect, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { isEditableTarget } from '../lib/editable-target'
import { getSelectedTextForFileSearch } from '../lib/file-search-selection'
import { registerAppCommandDispatcher } from '@/lib/app-command-dispatch'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { findPluginCommandForKeybinding } from '@/lib/plugin-command-keybindings'
import {
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspaceTerminalInputTarget,
  matchFloatingWorkspacePanelChord,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut
} from '@/lib/floating-workspace-terminal-actions'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import {
  folderRelativePathToIncludeGlob,
  selectedExplorerFolderRelativePath
} from '../components/right-sidebar/file-search-include-pattern'
import { usePluginCommands } from '@/store/plugin-panels'
import { useAppStore } from '../store'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingMatchOptions
} from '../../../shared/keybindings'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/plugin-command-actions'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../shared/modifier-double-tap-detector'
import { shortcutPlatform } from './app-window-chrome'
import {
  createAppCommandHandlers,
  getKeybindingContext,
  useAppShortcutActions,
  type AppShortcutState,
  type ShortcutDispatchInput
} from './app-command-handlers'
import type { AppChromeLayout } from './use-app-chrome-layout'
import type { FloatingWorkspacePanelState } from './use-floating-workspace-panel'
import { addEventListenerOnAllWindows } from '@/lib/aux-pane-window-registry'
import { activeElementFor, isElement, isNode } from '@/lib/cross-realm-dom-predicates'
import {
  getTerminalShortcutPaneHandle,
  resolveTerminalShortcutTabId,
  resolveTerminalShortcutTarget
} from '@/components/terminal/aux-pane-shortcut-target'

/** Registers long-lived window shortcuts that read current committed state through a ref. */
export function useGlobalKeybindings(args: {
  layout: AppChromeLayout
  floatingWorkspace: FloatingWorkspacePanelState
}): void {
  const { layout, floatingWorkspace } = args
  const actions = useAppShortcutActions()
  const keybindings = useAppStore((s) => s.keybindings)
  const terminalShortcutPolicy = useAppStore((s) => s.settings?.terminalShortcutPolicy)
  const pluginCommands = usePluginCommands()

  const shortcutState: AppShortcutState = {
    activeView: layout.activeView,
    activeWorktreeId: layout.activeWorktreeId,
    actions,
    creationLayoutActive: layout.creationLayoutActive,
    floatingTerminalEnabled: floatingWorkspace.enabled,
    floatingTerminalOpen: floatingWorkspace.open,
    floatingVisibleTabCount: floatingWorkspace.visibleTabCount,
    keybindings,
    openFloatingWorkspaceMaximized: floatingWorkspace.openMaximized,
    pluginCommands,
    setFloatingTerminalOpen: floatingWorkspace.setOpenWithFocus,
    terminalShortcutPolicy,
    workspaceChromeActive: layout.workspaceChromeActive
  }
  const shortcutStateRef = useRef(shortcutState)
  // Why useLayoutEffect: the mirror must be current before any key event can read it, and a
  // render-phase write would also publish state from a render React discards. Key events are
  // discrete, so they always observe the committed value.
  useLayoutEffect(() => {
    shortcutStateRef.current = shortcutState
  })

  useEffect(() => {
    const doubleTapDetector = new ModifierDoubleTapDetector()

    const unregisterAppCommandDispatcher = registerAppCommandDispatcher((actionId) =>
      (createAppCommandHandlers(shortcutStateRef.current).get(actionId) ?? (() => false))()
    )

    const dispatchShortcutInput = (input: ShortcutDispatchInput): void => {
      const state = shortcutStateRef.current
      const {
        activeView,
        activeWorktreeId,
        actions,
        creationLayoutActive,
        floatingTerminalEnabled,
        floatingTerminalOpen,
        floatingVisibleTabCount,
        keybindings,
        openFloatingWorkspaceMaximized,
        pluginCommands,
        setFloatingTerminalOpen,
        terminalShortcutPolicy
      } = state

      // Child handlers (e.g. terminal search) share this window capture phase and fire first; bail if they already preventDefault'd so both don't act.
      if (input.defaultPrevented) {
        return
      }
      // The Settings shortcut recorder captures existing shortcuts, so global handlers must not fire while its button has focus.
      if (
        isElement(input.target) &&
        input.target.closest('[data-shortcut-recorder-active]') !== null
      ) {
        return
      }
      const context = getKeybindingContext(input.target)
      const shortcutTarget = resolveTerminalShortcutTarget(input.target, useAppStore.getState())

      // Note: some shortcuts are also intercepted in createMainWindow.ts before-input-event (for browser-guest focus); the renderer keeps handlers for local focus.

      const matchShortcut = (actionId: KeybindingActionId): boolean =>
        keybindingMatchesAction(actionId, input, shortcutPlatform, keybindings, {
          context,
          terminalShortcutPolicy
        })
      const notifyTerminalCapture = (actionId: KeybindingActionId): void => {
        if (context !== 'terminal' || (terminalShortcutPolicy ?? 'orca-first') !== 'orca-first') {
          return
        }
        showTerminalShortcutCaptureNotification({
          actionId,
          platform: shortcutPlatform,
          keybindings
        })
      }

      if (context === 'terminal' && shortcutTarget?.auxiliary && matchShortcut('tab.close')) {
        const terminalTabId = resolveTerminalShortcutTabId(shortcutTarget, useAppStore.getState())
        const pane = terminalTabId ? getTerminalShortcutPaneHandle(terminalTabId) : null
        // Why: suppress Chromium aux-window close while its pane handle mounts.
        input.preventDefault()
        input.stopImmediatePropagation?.()
        if (pane) {
          notifyTerminalCapture('tab.close')
          pane.closeActivePane()
        }
        return
      }
      const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)

      if (matchShortcut('sidebar.search.toggle') && canRevealRightSidebar) {
        // With a folder selected in the explorer, Cmd/Ctrl+Shift+F means "Find in Folder" — seed the include pattern with it, not a text search.
        const activeElement = activeElementFor(isNode(input.target) ? input.target : null)
        const selectedFolderRelativePath = isElement(activeElement)
          ? selectedExplorerFolderRelativePath(activeElement)
          : null
        if (selectedFolderRelativePath !== null && activeWorktreeId) {
          input.preventDefault()
          notifyTerminalCapture('sidebar.search.toggle')
          actions.showRightSidebarSearch({
            includePattern: folderRelativePathToIncludeGlob(selectedFolderRelativePath)
          })
          return
        }

        const selectedText = getSelectedTextForFileSearch()
        if (selectedText) {
          input.preventDefault()
          notifyTerminalCapture('sidebar.search.toggle')
          actions.showRightSidebarSearch({ query: selectedText })
          return
        }
      }

      // An empty floating workspace has no tab to close, so Cmd/Ctrl+W hides the overlay before other surfaces act.
      if (
        keybindingMatchesAction('tab.close', input, shortcutPlatform, keybindings, {
          context: 'app'
        }) &&
        shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
          floatingTerminalOpen,
          floatingVisibleTabCount
        })
      ) {
        input.preventDefault()
        setFloatingTerminalOpen(false)
        return
      }

      // Floating panel closed → its keydown handler is gone, so honor the maximize chord here by opening it pre-maximized (no-op while it's open).
      if (
        !floatingTerminalOpen &&
        matchShortcut('floatingWorkspace.maximize') &&
        floatingTerminalEnabled
      ) {
        input.preventDefault()
        openFloatingWorkspaceMaximized()
        return
      }

      // Skip editable surfaces so TipTap's Cmd+B bold works; this renderer-side fallback covers the blur→press IPC race (docs/markdown-cmd-b-bold-design.md).
      if (isEditableTarget(input.target)) {
        return
      }

      // Let floating-terminal SSH/tmux control chords reach the terminal (xterm's helper textarea isn't a generic editable target).
      if (isFloatingWorkspaceTerminalInputTarget(input.target)) {
        return
      }

      // Only short-circuit chords the floating panel itself claims; suppressing others here would silently no-op them when focus is in the panel.
      if (isFloatingWorkspacePanelFocused()) {
        const floatingMatchOptions: KeybindingMatchOptions = { context, terminalShortcutPolicy }
        if (
          matchFloatingWorkspacePanelChord(
            input,
            shortcutPlatform,
            null,
            keybindings,
            floatingMatchOptions
          ) !== null
        ) {
          return
        }
      }

      // Plugin chords are user-reviewed instructional content. They win over
      // built-in defaults only in app focus; terminal/editor/browser handlers
      // retain their own shortcut authority.
      if (context === 'app') {
        const pluginCommand = findPluginCommandForKeybinding(
          pluginCommands,
          input,
          shortcutPlatform,
          keybindings,
          Boolean(activeWorktreeId)
        )
        if (pluginCommand) {
          input.preventDefault()
          void executePluginCommand(pluginCommand, 'plugin-keybinding').catch(() => {
            toast.error(
              translate('auto.App.pluginCommandFailed', 'Could not run the plugin command.')
            )
          })
          return
        }
      }

      const handlers = createAppCommandHandlers(state, input, context, shortcutTarget)
      for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
        if (matchShortcut(actionId) && handlers.get(actionId)?.()) {
          return
        }
      }

      // Unbound by default, so it runs after the built-in alias handlers above; only consumes the chord when the active worktree has unsent notes.
      if (canRevealRightSidebar && matchShortcut('sourceControl.sendReviewNotes')) {
        if (actions.openDiffNotesSendMenuForActiveWorktree()) {
          input.preventDefault()
          notifyTerminalCapture('sourceControl.sendReviewNotes')
        }
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      )
      if (e.repeat) {
        return
      }
      if (detected) {
        // Synthetic input: no key/modifier flags, so only DoubleTap bindings match.
        dispatchShortcutInput({
          doubleTapModifier: detected.modifier,
          target: e.target,
          defaultPrevented: e.defaultPrevented,
          preventDefault: () => e.preventDefault(),
          stopImmediatePropagation: () => e.stopImmediatePropagation()
        })
        return
      }
      dispatchShortcutInput({
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        target: e.target,
        defaultPrevented: e.defaultPrevented,
        preventDefault: () => e.preventDefault(),
        stopImmediatePropagation: () => e.stopImmediatePropagation()
      })
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey
        }),
        Date.now()
      )
    }

    // Why: a window blur mid-gesture must not leave the detector armed.
    const onBlur = (): void => doubleTapDetector.reset()

    const removeListeners = [
      addEventListenerOnAllWindows('keydown', onKeyDown, { capture: true }),
      addEventListenerOnAllWindows('keyup', onKeyUp, { capture: true }),
      addEventListenerOnAllWindows('blur', onBlur)
    ]
    return () => {
      unregisterAppCommandDispatcher()
      for (const removeListener of removeListeners) {
        removeListener()
      }
    }
  }, [])
}
