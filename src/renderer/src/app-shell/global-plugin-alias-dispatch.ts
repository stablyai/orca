import { matchesSpatialPaneFocusShortcut } from '../../../shared/spatial-pane-shortcut-policy'
import type { KeybindingActionId, KeybindingContext } from '../../../shared/keybindings'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../../../shared/plugins/contributions/plugin-command-actions'
import { isInsideNativeChatCover } from '@/components/terminal-pane/chat/native-chat-covered-pane'

function globalKeybindingSkipsWorktreeHistory(
  context: KeybindingContext,
  target: EventTarget | null,
  actionId: KeybindingActionId,
  spatialPaneConflict: boolean
): boolean {
  return (
    // A pane's chat cover routes spatial chords like the xterm it covers, though its context is 'app'.
    (context === 'terminal' || isInsideNativeChatCover(target)) &&
    spatialPaneConflict &&
    (actionId === 'worktree.history.back' || actionId === 'worktree.history.forward') &&
    // Why: only PaneManager panes walk spatially; preview, standalone and Plain SSH xterms keep history here.
    target instanceof Element &&
    target.closest('.pane[data-pane-id]') !== null
  )
}

export function dispatchGlobalPluginAliasActions(args: {
  context: KeybindingContext
  target: EventTarget | null
  isPhysicalKey?: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  runAction: (actionId: KeybindingActionId) => boolean
}): boolean {
  const spatialPaneConflict =
    args.isPhysicalKey !== false && matchesSpatialPaneFocusShortcut(args.matchShortcut)
  for (const actionId of PLUGIN_COMMAND_ALIAS_ACTION_IDS) {
    if (
      globalKeybindingSkipsWorktreeHistory(args.context, args.target, actionId, spatialPaneConflict)
    ) {
      continue
    }
    if (args.matchShortcut(actionId) && args.runAction(actionId)) {
      return true
    }
  }
  return false
}
