import {
  addHardwareKeyboardCommandListener,
  setHardwareKeyboardCommands,
  type HardwareKeyboardCommandEvent,
  type HardwareKeyboardNativeCommand
} from '@orca/expo-hardware-keyboard-navigation'
import type { KeybindingContext } from '../../../src/shared/keybindings'
import { Platform } from 'react-native'
import {
  getMobileHardwareKeyboardPreferences,
  loadMobileHardwareKeyboardPreferences,
  subscribeMobileHardwareKeyboardPreferences
} from './mobile-hardware-keyboard-preferences'
import {
  buildMobileHardwareKeyboardCommands,
  hardwareKeyboardCommandIdentity
} from './mobile-hardware-keyboard-bindings'
import type { MobileHardwareKeyboardActionId } from './mobile-hardware-keyboard-actions'

type CommandScope = {
  actionIds: readonly MobileHardwareKeyboardActionId[]
  context: KeybindingContext
  handler: (event: HardwareKeyboardCommandEvent) => void
}

const scopes = new Map<number, CommandScope>()
let nextScopeId = 1
let nativeSubscription: ReturnType<typeof addHardwareKeyboardCommandListener> = null

subscribeMobileHardwareKeyboardPreferences(syncNativeCommands)

export function registerMobileHardwareKeyboardScope(scope: CommandScope): () => void {
  const id = nextScopeId++
  scopes.set(id, scope)
  ensureNativeSubscription()
  void loadMobileHardwareKeyboardPreferences().then(syncNativeCommands)
  syncNativeCommands()
  return () => {
    scopes.delete(id)
    syncNativeCommands()
    if (scopes.size === 0) {
      nativeSubscription?.remove()
      nativeSubscription = null
    }
  }
}

function ensureNativeSubscription(): void {
  nativeSubscription ??= addHardwareKeyboardCommandListener((event) => {
    const activeScopes = [...scopes.values()].toReversed()
    activeScopes
      .find((scope) => scope.actionIds.some((actionId) => actionId === event.actionId))
      ?.handler(event)
  })
}

function syncNativeCommands(): void {
  const preferences = getMobileHardwareKeyboardPreferences()
  const platform = Platform.OS === 'ios' ? 'darwin' : 'linux'
  const commands: HardwareKeyboardNativeCommand[] = []
  const seen = new Set<string>()
  const claimedActionIds = new Set<MobileHardwareKeyboardActionId>()
  for (const scope of [...scopes.values()].toReversed()) {
    const actionIds = scope.actionIds.filter((actionId) => !claimedActionIds.has(actionId))
    scope.actionIds.forEach((actionId) => claimedActionIds.add(actionId))
    for (const command of buildMobileHardwareKeyboardCommands({
      actionIds,
      context: scope.context,
      platform,
      terminalShortcutPolicy: preferences.terminalShortcutPolicy
    })) {
      const identity = hardwareKeyboardCommandIdentity(command)
      if (!seen.has(identity)) {
        seen.add(identity)
        commands.push(command)
      }
    }
  }
  setHardwareKeyboardCommands(commands)
}
