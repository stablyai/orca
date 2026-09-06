import type { KeybindingActionId } from '../../../src/shared/keybindings'

export const MOBILE_WORKTREE_KEYBOARD_ACTIONS = [
  'worktree.palette',
  'worktree.navigateUp',
  'worktree.navigateDown',
  'workspace.selectByIndex',
  'worktree.history.back',
  'worktree.history.forward'
] as const satisfies readonly KeybindingActionId[]

export const MOBILE_TAB_KEYBOARD_ACTIONS = [
  'tab.previousAllTypes',
  'tab.nextAllTypes',
  'tab.previousSameType',
  'tab.nextSameType',
  'tab.previousRecent',
  'tab.previousTerminal',
  'tab.nextTerminal',
  'tab.selectByIndex'
] as const satisfies readonly KeybindingActionId[]

export const MOBILE_HARDWARE_KEYBOARD_ACTIONS = [
  ...MOBILE_WORKTREE_KEYBOARD_ACTIONS,
  ...MOBILE_TAB_KEYBOARD_ACTIONS
] as const satisfies readonly KeybindingActionId[]

export type MobileHardwareKeyboardActionId = (typeof MOBILE_HARDWARE_KEYBOARD_ACTIONS)[number]

export function isMobileHardwareKeyboardActionId(
  actionId: string
): actionId is MobileHardwareKeyboardActionId {
  return (MOBILE_HARDWARE_KEYBOARD_ACTIONS as readonly string[]).includes(actionId)
}
