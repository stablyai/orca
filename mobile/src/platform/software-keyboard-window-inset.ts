/**
 * The strip at the bottom of the window the software keyboard takes, for a view that owns the
 * window and has to shorten itself out of the way. The two platforms measure the IME from
 * different edges: iOS's frame height starts at the bottom of the window and already spans the
 * home indicator, Android's starts above the system bars, so only Android adds the bar back.
 */
export function softwareKeyboardWindowInset(input: {
  keyboardHeight: number
  bottomInset: number
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  if (keyboardHeight === 0) {
    return 0
  }
  return input.platform === 'ios' ? keyboardHeight : keyboardHeight + Math.max(0, input.bottomInset)
}
