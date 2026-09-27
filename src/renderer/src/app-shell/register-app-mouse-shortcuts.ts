import { keybindingMatchesInput } from '../../../shared/keybindings'
import { parseMouseShortcutInput } from '../../../shared/mouse-shortcut-input'
import { resolveWindowShortcutAction } from '../../../shared/window-shortcut-policy'
import { registerMouseShortcutDispatch } from '@/lib/mouse-shortcut-dispatch'
import { getKeybindingContext, type AppShortcutState } from './app-command-handlers'
import { shortcutPlatform } from './app-window-chrome'

export function registerAppMouseShortcuts(
  getState: () => Pick<AppShortcutState, 'keybindings' | 'terminalShortcutPolicy'>
): () => void {
  return registerMouseShortcutDispatch(
    (input) =>
      Object.values(getState().keybindings).some((bindings) =>
        bindings?.some((binding) => keybindingMatchesInput(binding, input, shortcutPlatform))
      ),
    (input) => {
      const mouseInput = parseMouseShortcutInput(input)
      const state = getState()
      if (
        !mouseInput ||
        !window.api.ui.dispatchMouseShortcut ||
        !resolveWindowShortcutAction(mouseInput, shortcutPlatform, state.keybindings, {
          context: getKeybindingContext(input.target),
          terminalShortcutPolicy: state.terminalShortcutPolicy
        })
      ) {
        return false
      }
      window.api.ui.dispatchMouseShortcut(mouseInput)
      return true
    }
  )
}
