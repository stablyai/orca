export type TerminalKeyboardDismissHandle = { blur: () => void } | null | undefined

export type DismissTerminalKeyboardOptions = {
  clearPendingLiveInputFocus: () => void
  commandInput: TerminalKeyboardDismissHandle
  dismissKeyboard: () => void
  liveInput: TerminalKeyboardDismissHandle
}

export function dismissTerminalKeyboard(options: DismissTerminalKeyboardOptions): void {
  // Clear deferred live focus before dismissing or it can immediately reopen the iOS keyboard.
  options.clearPendingLiveInputFocus()
  options.liveInput?.blur()
  options.commandInput?.blur()
  options.dismissKeyboard()
}
