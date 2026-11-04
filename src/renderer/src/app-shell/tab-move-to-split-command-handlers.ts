import {
  moveTabToNewPaneColumn,
  resolveActiveTabPaneColumnMove
} from '../components/tab-bar/tab-move-to-pane-column'
import { useAppStore } from '../store'
import { TAB_MOVE_TO_SPLIT_COMMANDS, type KeybindingActionId } from '../../../shared/keybindings'

/** Claims a move-to-split chord only after the store accepts the move. */
export function createTabMoveToSplitHandlers(
  available: boolean,
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): (readonly [KeybindingActionId, () => boolean])[] {
  return TAB_MOVE_TO_SPLIT_COMMANDS.map(
    ({ id, direction }) =>
      [
        id,
        () => {
          if (!available) {
            return false
          }
          const move = resolveActiveTabPaneColumnMove(useAppStore.getState())
          if (!move || !moveTabToNewPaneColumn({ ...move, direction })) {
            return false
          }
          return claim(id, () => {})
        }
      ] as const
  )
}
