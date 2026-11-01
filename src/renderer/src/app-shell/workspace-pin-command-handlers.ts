import {
  applyWorkspacePinIntent,
  resolveWorkspacePinShortcutTarget,
  type WorkspacePinIntent
} from '../components/sidebar/workspace-pin-shortcut-target'
import { useAppStore } from '../store'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { KeybindingActionId } from '../../../shared/keybindings'

export type ClaimShortcut = (actionId: KeybindingActionId, run: () => void) => boolean

/** Dispatched explicitly like `workspace.delete`: the resolver reads hover and focus, which a
 *  palette-run plugin alias would trip while the search box still holds focus. */
export const WORKSPACE_PIN_ACTION_IDS = [
  'workspace.pin',
  'workspace.unpin',
  'workspace.togglePin'
] as const satisfies readonly KeybindingActionId[]

/** Pin, unpin and toggle-pin share one target resolver and fall through when nothing is targetable. */
export function createWorkspacePinCommandHandlers(deps: {
  floatingWorkspaceFocused: boolean
  claim: ClaimShortcut
}): [KeybindingActionId, () => boolean][] {
  const setWorkspacePin = (actionId: KeybindingActionId, intent: WorkspacePinIntent): boolean => {
    // Why: an open menu drops :hover from the row it was opened on, so the resolver would pin the
    // focused workspace instead of that row; declining is what delete does in the same state.
    if (deps.floatingWorkspaceFocused || hasVisibleOverlay()) {
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
