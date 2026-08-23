export function resolveSessionBackPress({
  liveInputFocused,
  hardwareKeyboard
}: {
  liveInputFocused: boolean
  hardwareKeyboard: boolean
}): 'send-escape' | 'leave' {
  return liveInputFocused && hardwareKeyboard ? 'send-escape' : 'leave'
}
