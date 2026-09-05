import type { HardwareKeyboardNativeCommand } from '@orca/expo-hardware-keyboard-navigation'
import {
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  isDigitIndexActionId,
  keybindingIsActiveInContext,
  parseKeybinding,
  type KeybindingContext,
  type TerminalShortcutPolicy
} from '../../../src/shared/keybindings'
import type { MobileHardwareKeyboardActionId } from './mobile-hardware-keyboard-actions'

export type MobileKeyboardPlatform = 'darwin' | 'linux'

export function buildMobileHardwareKeyboardCommands(options: {
  actionIds: readonly MobileHardwareKeyboardActionId[]
  context: KeybindingContext
  platform: MobileKeyboardPlatform
  terminalShortcutPolicy: TerminalShortcutPolicy
}): HardwareKeyboardNativeCommand[] {
  const commands: HardwareKeyboardNativeCommand[] = []
  for (const actionId of options.actionIds) {
    const definition = getKeybindingDefinition(actionId)
    if (
      !definition ||
      !keybindingIsActiveInContext(definition, {
        context: options.context,
        terminalShortcutPolicy: options.terminalShortcutPolicy
      })
    ) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForAction(actionId, options.platform)) {
      const parsed = parseKeybinding(binding)
      if (!parsed || parsed.doubleTapModifier) {
        continue
      }
      const keys = isDigitIndexActionId(actionId)
        ? ['1', '2', '3', '4', '5', '6', '7', '8', '9']
        : [parsed.key]
      for (const key of keys) {
        commands.push({
          actionId,
          key,
          control: parsed.control || (parsed.mod && options.platform !== 'darwin'),
          meta: parsed.meta || (parsed.mod && options.platform === 'darwin'),
          alt: parsed.alt,
          shift: parsed.shift
        })
      }
    }
  }
  return commands
}

export function hardwareKeyboardCommandIdentity(command: HardwareKeyboardNativeCommand): string {
  return [
    command.control ? 'C' : '',
    command.meta ? 'M' : '',
    command.alt ? 'A' : '',
    command.shift ? 'S' : '',
    command.key
  ].join(':')
}
