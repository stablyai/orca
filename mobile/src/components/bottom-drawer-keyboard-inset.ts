// iOS keyboard frame includes home indicator; Android IME excludes nav bar, matching session terminal contract.
// Fill sheets always use raw height for dock/marginBottom. Content-sized translate path subtracts safe-bottom only on iOS, where padding already covers it.

export function resolveBottomDrawerKeyboardInset(input: {
  keyboardHeight: number
  bottomInset: number
  fillAvailable: boolean
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'web'
}): number {
  const keyboardHeight = Math.max(0, input.keyboardHeight)
  if (input.fillAvailable) {
    return keyboardHeight
  }
  if (input.platform === 'ios') {
    return Math.max(0, keyboardHeight - Math.max(0, input.bottomInset))
  }
  return keyboardHeight
}
