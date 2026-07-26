export function resolveMobileKeyboardInset(input: {
  keyboardHeight: number
  bottomInset: number
  includesSafeArea: boolean
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  if (input.includesSafeArea || input.platform !== 'ios') {
    return keyboardHeight
  }
  return Math.max(0, keyboardHeight - Math.max(0, input.bottomInset))
}
