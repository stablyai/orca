import { translateMain } from '../i18n/main-i18n'
import {
  isAnyWslMoveRunning,
  isWslMoveUndoRunning
} from '../persistence/moving-wsl-projects/wsl-move-running-moves'

/**
 * Why an install must wait: quitting would interrupt a move (it recovers, but the projects stay
 * read-only until then) or an undo midway through stopping the host's terminals. Null otherwise.
 */
export function wslMoveInstallHold(): { lifecycleEvent: string; message: string } | null {
  if (isAnyWslMoveRunning()) {
    return {
      lifecycleEvent: 'quit_and_install_held_for_wsl_move',
      message: translateMain(
        'updates.wslMoveInstallHeld',
        'A project is moving to its WSL host. Install the update once the move finishes.'
      )
    }
  }
  if (isWslMoveUndoRunning()) {
    return {
      lifecycleEvent: 'quit_and_install_held_for_wsl_move_undo',
      message: translateMain(
        'updates.wslMoveUndoInstallHeld',
        'A project is coming back from its WSL host. Install the update once that finishes.'
      )
    }
  }
  return null
}
