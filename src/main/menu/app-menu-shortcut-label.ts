import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../shared/keybindings'

/** Display-only hint for a menu label; the chord itself is routed by Orca, not the menu. */
export function formatAppMenuShortcut(
  actionId: KeybindingActionId,
  keybindings: KeybindingOverrides | undefined
): string {
  return formatKeybindingList(
    getEffectiveKeybindingsForAction(actionId, process.platform, keybindings),
    process.platform
  )
}

/** Appends the shortcut hint only when the action is bound, so no "Unassigned" lands in the menu. */
export function appMenuLabelWithOptionalShortcut(
  label: string,
  actionId: KeybindingActionId,
  keybindings: KeybindingOverrides | undefined
): string {
  const bindings = getEffectiveKeybindingsForAction(actionId, process.platform, keybindings)
  return bindings.length ? `${label}\t${formatKeybindingList(bindings, process.platform)}` : label
}
