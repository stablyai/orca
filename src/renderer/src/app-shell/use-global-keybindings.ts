import { useEffect, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { fileSearchClaimsTextKey } from '../lib/file-search-shortcut-policy'
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
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { isAgentTerminalPreviewTarget } from '../components/dashboard-popout/agent-terminal-preview-target'

/** Register window listeners once; each key event reads the latest committed shortcut state through a ref. */
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
  // Mirror committed state before discrete key events; render-phase writes could leak discarded renders.
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

      // Other routed owners may run first; never act twice on prevented input.
      if (input.defaultPrevented || input.isComposing || input.key === 'Process') {
        return
      }
      // Let the focused Settings recorder capture shortcuts without executing them.
      if (
        input.target instanceof Element &&
        input.target.closest('[data-shortcut-recorder-active]') !== null
      ) {
        return
      }
      const context = getKeybindingContext(input.target)

      // Main also intercepts browser-guest shortcuts; renderer handlers cover local focus.

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

      const canRevealRightSidebar = !creationLayoutActive && canShowRightSidebarForView(activeView)

      if (matchShortcut('sidebar.search.toggle') && canRevealRightSidebar) {
        // Find in Folder uses the selected folder as an include pattern.
        const selectedFolderRelativePath =
          document.activeElement instanceof Element
            ? selectedExplorerFolderRelativePath(document.activeElement)
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
        !isAgentTerminalPreviewTarget(input.target) &&
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

      // A closed floating panel has no handler; honor maximize by opening it pre-maximized.
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
      if (fileSearchClaimsTextKey(input)) {
        return
      }

      // Let SSH/tmux control chords reach xterm; its helper textarea is not an ordinary editor.
      if (isFloatingWorkspaceTerminalInputTarget(input.target)) {
        return
      }

      // Suppress only chords the focused floating panel claims; let others fall through.
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

      // Reviewed plugin chords beat built-in defaults only in app focus; terminal/editor/browser retain their own authority.
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

      const handlers = createAppCommandHandlers(state, input, context)
      if (matchShortcut('workspace.delete') && handlers.get('workspace.delete')?.()) {
        return
      }
      if (
        matchShortcut('sidebar.childWorkspaces.toggle') &&
        handlers.get('sidebar.childWorkspaces.toggle')?.()
      ) {
        return
      }
      for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
        if (matchShortcut(actionId) && handlers.get(actionId)?.()) {
          return
        }
      }

      // Run this unbound alias after built-ins; claim it only when unsent review notes exist.
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
        // No key/modifier flags: synthetic input matches only DoubleTap bindings.
        dispatchShortcutInput({
          isComposing: e.isComposing,
          altGraph: e.getModifierState('AltGraph'),
          doubleTapModifier: detected.modifier,
          target: e.target,
          defaultPrevented: e.defaultPrevented,
          preventDefault: () => e.preventDefault()
        })
        return
      }
      dispatchShortcutInput({
        isComposing: e.isComposing,
        altGraph: e.getModifierState('AltGraph'),
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        target: e.target,
        defaultPrevented: e.defaultPrevented,
        preventDefault: () => e.preventDefault()
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

    // Blur must disarm an unfinished gesture.
    const onBlur = (): void => doubleTapDetector.reset()

    addAppKeyListener('keydown', onKeyDown)
    addAppKeyListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      unregisterAppCommandDispatcher()
      removeAppKeyListener('keydown', onKeyDown)
      removeAppKeyListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
