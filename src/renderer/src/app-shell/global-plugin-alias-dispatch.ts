import type { KeybindingActionId, KeybindingContext } from '../../../shared/keybindings'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/plugin-command-actions'

export function globalKeybindingSkipsWorktreeHistory(
  context: KeybindingContext,
  actionId: KeybindingActionId
): boolean {
  return (
    context === 'terminal' &&
    (actionId === 'worktree.history.back' || actionId === 'worktree.history.forward')
  )
}

export function dispatchGlobalPluginAliasActions(args: {
  context: KeybindingContext
  matchShortcut: (actionId: KeybindingActionId) => boolean
  runAction: (actionId: KeybindingActionId) => boolean
}): boolean {
  for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
    if (globalKeybindingSkipsWorktreeHistory(args.context, actionId)) {
      continue
    }
    if (args.matchShortcut(actionId) && args.runAction(actionId)) {
      return true
    }
  }
  return false
}
