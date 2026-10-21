import type { KeybindingActionId } from '../../../shared/keybindings'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'

export function createTabGroupCommandHandlers(
  enabled: boolean,
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): [KeybindingActionId, () => boolean][] {
  return (['tab.focusNextGroup', 'tab.focusPreviousGroup'] as const).map((actionId) => [
    actionId,
    () => {
      if (!enabled) {
        return false
      }
      const handled = dispatchWorkspaceTabCommand({
        type: 'focus-group',
        direction: actionId === 'tab.focusNextGroup' ? 1 : -1
      })
      return handled ? claim(actionId, () => {}) : false
    }
  ])
}
