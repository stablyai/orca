/**
 * The keyboard height the page is handed: its height above the bottom safe-area inset, which is
 * what Android reports and what the page's non-iOS code reads. iOS measures from the window's
 * bottom, home indicator included, and the page runs as `web`, so the strip comes off here.
 */
export function pageKeyboardInset(input: {
  keyboardHeight: number
  bottomInset: number
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  return input.platform === 'ios'
    ? Math.max(0, keyboardHeight - Math.max(0, input.bottomInset))
    : keyboardHeight
}
