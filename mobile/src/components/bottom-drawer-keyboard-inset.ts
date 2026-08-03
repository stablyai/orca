// Why: iOS keyboard frame height includes the home-indicator region; Android
// IME height does not include the system nav bar. That split is already used
// by the session terminal keyboard lift — keep fill/content-sized drawers on
// the same contract so OEM/Android and iPhone behave consistently.
//
// Fill sheets dock chrome to the *true keyboard top* via marginBottom + height
// shrink. They always use the raw frame height (subtracting safe-bottom on iOS
// parks the TextInput under the keys). Content-sized sheets keep the legacy
// translate path: iOS subtracts safe-bottom (padding already covers it),
// Android uses the full IME height.

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
