import { getFishClaudeShellFunction } from '../shared/claude-shell-function'
import { getFishCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import {
  FISH_SAVED_RESTORE_CAPTURE,
  FISH_SAVED_RESTORE_INSTALL
} from '../shared/saved-restore-dispatch'

/** fish -C after the ready hook: Orca's agent functions, and for a launch whose root owns a saved
 *  restore's start, the capture before them (so they record their definitions) and the action. */
export function getFishAgentInit(ownsSavedRestore: boolean): string {
  const functions =
    getFishCodexShellLaunchPreflight(ownsSavedRestore) +
    getFishClaudeShellFunction(ownsSavedRestore)
  return ownsSavedRestore
    ? `${FISH_SAVED_RESTORE_CAPTURE}\n${functions}\n${FISH_SAVED_RESTORE_INSTALL}`
    : functions
}
