export type TerminalKeyboardDismissHandle = { blur: () => void } | null | undefined

export type DismissTerminalKeyboardOptions = {
  clearPendingLiveInputFocus: () => void
  commandInput: TerminalKeyboardDismissHandle
  dismissKeyboard: () => void
  liveInput: TerminalKeyboardDismissHandle
}

export function dismissTerminalKeyboard(options: DismissTerminalKeyboardOptions): void {
  // Why: clear the queued live-input focus before blurring/dismissing so a
  // pending deferred focus cannot re-open the iOS keyboard right after Hide.
  options.clearPendingLiveInputFocus()
  options.liveInput?.blur()
  options.commandInput?.blur()
  options.dismissKeyboard()
}
