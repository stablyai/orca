import {
  KEYBINDING_DEFINITIONS,
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../shared/keybindings'
import type { WindowShortcutInput } from '../../shared/window-shortcut-policy'

// Why: neither acts on a page (open-markdown has no app-wide owner, rename only renames terminal and
// chat tabs), so claiming them would only take the chord from the page.
const TAB_ACTIONS_WITHOUT_KEYBOARD_OWNER = new Set<KeybindingActionId>([
  'tab.rename',
  'tab.openMarkdown'
])

/** A focused page hands tab chords and the Plugins launcher back to Orca. */
export function matchesGuestTabShortcut(
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  isMobileEmulatorEnabled: boolean
): boolean {
  return KEYBINDING_DEFINITIONS.some(
    (definition) =>
      (definition.scope === 'tabs' || definition.id === 'view.plugins') &&
      !TAB_ACTIONS_WITHOUT_KEYBOARD_OWNER.has(definition.id) &&
      (definition.id !== 'tab.newSimulator' || isMobileEmulatorEnabled) &&
      keybindingMatchesAction(definition.id, input, platform, keybindings)
  )
}
