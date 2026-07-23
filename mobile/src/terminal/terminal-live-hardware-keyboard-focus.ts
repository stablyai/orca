/**
 * Soft-keyboard request latch for live terminal hardware-keyboard focus.
 * Silent focus keeps the hidden field first-responder without raising the IME;
 * an explicit tap sets wantSoftKeyboard so the next focus opens the soft keyboard.
 */

export type TerminalLiveHardwareKeyboardFocusState = {
  readonly wantSoftKeyboard: boolean
  readonly liveInputEnabled: boolean
  readonly canSend: boolean
}

export type TerminalLiveHardwareKeyboardFocusDecision =
  | { readonly kind: 'idle' }
  | { readonly kind: 'silent-focus'; readonly showSoftInputOnFocus: false }
  | { readonly kind: 'soft-focus'; readonly showSoftInputOnFocus: true }

export function getTerminalLiveHardwareKeyboardFocusDecision(
  state: TerminalLiveHardwareKeyboardFocusState
): TerminalLiveHardwareKeyboardFocusDecision {
  if (!state.liveInputEnabled || !state.canSend) {
    return { kind: 'idle' }
  }
  if (state.wantSoftKeyboard) {
    return { kind: 'soft-focus', showSoftInputOnFocus: true }
  }
  return { kind: 'silent-focus', showSoftInputOnFocus: false }
}

/**
 * Silent focus when live mode / send capability enables a silent opportunity.
 * modalOpen is a runtime guard only — callers must NOT re-run silent focus solely
 * because a modal closed (that would steal focus after action sheets).
 */
export function shouldAutoSilentFocusLiveInput(options: {
  readonly liveInputEnabled: boolean
  readonly canSend: boolean
  readonly wantSoftKeyboard: boolean
  readonly isFocused: boolean
  readonly modalOpen: boolean
}): boolean {
  return (
    options.liveInputEnabled &&
    options.canSend &&
    !options.wantSoftKeyboard &&
    !options.isFocused &&
    !options.modalOpen
  )
}

// Explicit focus waits for the prop latch; an already focused silent field also
// needs a fresh responder cycle on platforms where focus() alone is a no-op.
export function planExplicitSoftKeyboardFocus(options: {
  readonly alreadyWantsSoftKeyboard: boolean
  readonly isFocused: boolean
}): { readonly kind: 'focus-now' | 'defer-until-latch' | 'blur-refocus-after-latch' } {
  if (!options.alreadyWantsSoftKeyboard) {
    // Latch was false — set it, wait for re-render, then focus (blur first if needed).
    return options.isFocused ? { kind: 'blur-refocus-after-latch' } : { kind: 'defer-until-latch' }
  }
  // Latch already true — can focus immediately; force IME if already focused silently.
  return options.isFocused ? { kind: 'blur-refocus-after-latch' } : { kind: 'focus-now' }
}
