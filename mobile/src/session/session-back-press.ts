type SessionBackPressHandlerArgs = {
  hardwareKeyboard: boolean
  isLiveInputFocused: () => boolean
  requestLeave: () => void
  sendEscape: () => void
}

export function resolveSessionBackPress({
  liveInputFocused,
  hardwareKeyboard
}: {
  liveInputFocused: boolean
  hardwareKeyboard: boolean
}): 'send-escape' | 'leave' {
  return liveInputFocused && hardwareKeyboard ? 'send-escape' : 'leave'
}

export function createSessionBackPressHandler({
  hardwareKeyboard,
  isLiveInputFocused,
  requestLeave,
  sendEscape
}: SessionBackPressHandlerArgs): () => boolean {
  return () => {
    if (
      resolveSessionBackPress({ liveInputFocused: isLiveInputFocused(), hardwareKeyboard }) ===
      'send-escape'
    ) {
      sendEscape()
    } else {
      requestLeave()
    }
    return true
  }
}
