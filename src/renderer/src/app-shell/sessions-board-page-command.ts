import type { KeybindingActionId } from '../../../shared/keybindings'
import { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>
type Claim = (actionId: KeybindingActionId, run: () => void) => boolean

/**
 * The Sessions board's keybinding entry. It lives apart from the rest of the command map
 * because it is the one full-page surface an experiment gates: the handler has to agree
 * with the sidebar about whether the surface exists at all, or a chord the user bound
 * would resolve to nothing.
 */
export function sessionsBoardPageCommand(
  activeView: AppStoreState['activeView'],
  claim: Claim
): [KeybindingActionId, () => boolean] {
  return [
    'view.sessions',
    () => {
      const store = useAppStore.getState()
      if (activeView === 'settings' || store.settings?.experimentalSessionsBoard !== true) {
        return false
      }
      return claim('view.sessions', () => store.openSessionsPage())
    }
  ]
}
