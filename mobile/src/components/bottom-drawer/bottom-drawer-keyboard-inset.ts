// iOS keyboard frame includes home indicator; Android IME excludes nav bar, matching session terminal contract.
// Fill sheets' edge-to-edge window reaches under the nav bar, so Android adds it back. Content-sized translate path subtracts safe-bottom only on iOS, where padding already covers it.

export function resolveBottomDrawerKeyboardInset(input: {
  keyboardHeight: number
  bottomInset: number
  fillAvailable: boolean
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  if (input.fillAvailable) {
    // Sum before clamping: RN reports IME minus system bars, negative for an IME shorter than the bar.
    const navigationBar = input.platform === 'android' ? Math.max(0, input.bottomInset) : 0
    return Math.max(0, input.keyboardHeight + navigationBar)
  }
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  if (input.platform === 'ios') {
    return Math.max(0, keyboardHeight - Math.max(0, input.bottomInset))
  }
  return keyboardHeight
}
