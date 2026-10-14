import {
  applyWorkspacePinIntent,
  resolveWorkspacePinShortcutTarget,
  type WorkspacePinIntent
} from '../components/sidebar/workspace-pin-shortcut-target'
import { useAppStore } from '../store'
import type { KeybindingActionId } from '../../../shared/keybindings'

export type ClaimShortcut = (actionId: KeybindingActionId, run: () => void) => boolean

/** Pin, unpin and toggle-pin share one target resolver and fall through when nothing is targetable. */
export function createWorkspacePinCommandHandlers(deps: {
  floatingWorkspaceFocused: boolean
  claim: ClaimShortcut
}): [KeybindingActionId, () => boolean][] {
  const setWorkspacePin = (actionId: KeybindingActionId, intent: WorkspacePinIntent): boolean => {
    if (deps.floatingWorkspaceFocused) {
      return false
    }
    const store = useAppStore.getState()
    const target = resolveWorkspacePinShortcutTarget(store)
    if (!target) {
      return false
    }
    return deps.claim(actionId, () => applyWorkspacePinIntent(store, target, intent))
  }
  return [
    ['workspace.pin', () => setWorkspacePin('workspace.pin', 'pin')],
    ['workspace.unpin', () => setWorkspacePin('workspace.unpin', 'unpin')],
    ['workspace.togglePin', () => setWorkspacePin('workspace.togglePin', 'toggle')]
  ]
}
