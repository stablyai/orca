import AsyncStorage from '@react-native-async-storage/async-storage'
import type { TerminalShortcutPolicy } from '../../../src/shared/keybindings'

const TERMINAL_POLICY_KEY = 'orca:hardwareKeyboardTerminalShortcutPolicy'

export type MobileHardwareKeyboardPreferences = {
  loaded: boolean
  terminalShortcutPolicy: TerminalShortcutPolicy
}

let snapshot: MobileHardwareKeyboardPreferences = {
  loaded: false,
  terminalShortcutPolicy: 'orca-first'
}
let loadPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

export function getMobileHardwareKeyboardPreferences(): MobileHardwareKeyboardPreferences {
  return snapshot
}

export function subscribeMobileHardwareKeyboardPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function loadMobileHardwareKeyboardPreferences(): Promise<void> {
  if (loadPromise) {
    return loadPromise
  }
  loadPromise = AsyncStorage.getItem(TERMINAL_POLICY_KEY)
    .then((stored) => {
      publish({
        loaded: true,
        terminalShortcutPolicy: stored === 'terminal-first' ? 'terminal-first' : 'orca-first'
      })
    })
    .catch(() => publish({ ...snapshot, loaded: true }))
  return loadPromise
}

export async function saveMobileTerminalShortcutPolicy(
  terminalShortcutPolicy: TerminalShortcutPolicy
): Promise<void> {
  await AsyncStorage.setItem(TERMINAL_POLICY_KEY, terminalShortcutPolicy)
  publish({ loaded: true, terminalShortcutPolicy })
}

function publish(next: MobileHardwareKeyboardPreferences): void {
  snapshot = next
  listeners.forEach((listener) => listener())
}
