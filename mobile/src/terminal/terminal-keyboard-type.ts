export type TerminalKeyboardPlatform = 'android' | 'ios' | 'web' | 'windows' | 'macos'
export type TerminalKeyboardType = 'ascii-capable' | 'default'

export function getTerminalLiveInputKeyboardType(
  platform: TerminalKeyboardPlatform
): TerminalKeyboardType {
  // Why: Android CJK IMEs need the normal system keyboard; password-style
  // input types suppress composition and break Chinese terminal input.
  return platform === 'ios' ? 'ascii-capable' : 'default'
}

export function getTerminalCommandKeyboardType(
  platform: TerminalKeyboardPlatform,
  autocompleteEnabled: boolean
): TerminalKeyboardType {
  if (autocompleteEnabled) {
    return 'default'
  }
  return platform === 'ios' ? 'ascii-capable' : 'default'
}
