export type TerminalKeyboardPlatform = 'android' | 'ios' | 'web' | 'windows' | 'macos'
export type TerminalKeyboardType = 'default'

// Why: terminal inputs use the system default keyboard so non-Latin IMEs (iOS
// Zhuyin/Japanese/Korean, Android CJK) stay selectable — ASCII-only keyboards hide them.
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
