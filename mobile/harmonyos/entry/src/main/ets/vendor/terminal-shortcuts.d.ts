interface TerminalShortcutKey {
  id: string
  label: string
  accessibilityLabel: string
}

interface TerminalShortcutBinding {
  key: string
  modifiers: string[]
}

interface TerminalShortcutBuildResult {
  label: string
  bytes: string
  accessibilityLabel: string
}

export interface TerminalAccessoryLayout {
  version: number
  orderedBuiltInIds: string[]
  visibleBuiltInIds: string[]
  directionPadEnabled: boolean
  smartRail: boolean
}

export interface TerminalShortcutDescription {
  label: string
  title: string
}

declare const terminalShortcuts: {
  TERMINAL_SHORTCUT_SPECIAL_KEYS: TerminalShortcutKey[]
  buildTerminalShortcutKey(binding: TerminalShortcutBinding): TerminalShortcutBuildResult | null
  normalizeShortcutKeyInput(value: string): string | null
  terminalAccessoryLayout(value: Object | null, directionPadAvailable: boolean): TerminalAccessoryLayout
  describeBuiltInShortcut(id: string, translate: (key: string, fallback: string) => string): TerminalShortcutDescription
}
export default terminalShortcuts
