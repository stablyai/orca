export type TerminalKeyboardPlatform = 'android' | 'ios' | 'web' | 'windows' | 'macos'
export type TerminalKeyboardType = 'default'

// Why: default keyboards keep non-Latin IMEs selectable; ASCII-only keyboards hide them.
// Parameters stay for call-site stability while autocomplete no longer changes the keyboard.
export function getTerminalLiveInputKeyboardType(
  _platform: TerminalKeyboardPlatform
): TerminalKeyboardType {
  return 'default'
}

export function getTerminalCommandKeyboardType(
  _platform: TerminalKeyboardPlatform,
  _autocompleteEnabled: boolean
): TerminalKeyboardType {
  return 'default'
}
