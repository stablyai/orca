import { matchesSpatialPaneFocusShortcut } from '../../../shared/spatial-pane-shortcut-policy'
import type { KeybindingActionId, KeybindingContext } from '../../../shared/keybindings'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/plugin-command-actions'

export function globalKeybindingSkipsWorktreeHistory(
  context: KeybindingContext,
  actionId: KeybindingActionId,
  spatialPaneConflict: boolean
): boolean {
  return (
    context === 'terminal' &&
    spatialPaneConflict &&
    (actionId === 'worktree.history.back' || actionId === 'worktree.history.forward')
  )
}

export function dispatchGlobalPluginAliasActions(args: {
  context: KeybindingContext
  isPhysicalKey?: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  runAction: (actionId: KeybindingActionId) => boolean
}): boolean {
  const spatialPaneConflict =
    args.isPhysicalKey !== false && matchesSpatialPaneFocusShortcut(args.matchShortcut)
  for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
    if (globalKeybindingSkipsWorktreeHistory(args.context, actionId, spatialPaneConflict)) {
      continue
    }
    if (args.matchShortcut(actionId) && args.runAction(actionId)) {
      return true
    }
  }
  return false
}
