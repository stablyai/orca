export type TerminalKeyboardPlatform = 'android' | 'ios' | 'web' | 'windows' | 'macos'
export type TerminalKeyboardType = 'default'

// Keep default keyboards for non-Latin IMEs; ASCII-only modes hide them. Autocomplete no longer changes this choice.
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
