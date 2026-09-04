export type NativeChatKeyboardDismissMode = 'interactive' | 'on-drag'

/** Which source is authoritative for the composer's lift right now. */
export type NativeChatKeyboardPhase =
  /** The observer has no live frame, so the route inset is authoritative. */
  | 'unreported'
  /** The keyboard is opening or open, so the route inset is authoritative. */
  | 'settling'
  /** The keyboard is leaving while the route inset remains stale. */
  | 'dismissing'

/** Interactive dismissal is safe only while iOS reports the keyboard frame. */
export function resolveNativeChatKeyboardDismissMode(
  platform: string,
  keyboardIsReported: boolean
): NativeChatKeyboardDismissMode {
  return platform === 'ios' && keyboardIsReported ? 'interactive' : 'on-drag'
}

/** Avoid waking React for direction changes within a reported keyboard session. */
export function nativeChatKeyboardIsReported(phase: NativeChatKeyboardPhase): boolean {
  'worklet'
  return phase !== 'unreported'
}

/** Keep a dismissal latched through direction changes until the keyboard settles. */
export function nativeChatKeyboardStaysLeaving(input: {
  wasLeaving: boolean
  isClosing: boolean
  hasSettled: boolean
}): boolean {
  'worklet'
  if (input.isClosing) {
    return true
  }
  return input.hasSettled ? false : input.wasLeaving
}

export type NativeChatBottomPadInput = {
  phase: NativeChatKeyboardPhase
  /** UI-thread distance from the keyboard's top edge to the window bottom. */
  liveKeyboardHeight: number
  /** Route lift, which stays stale until an interactive dismissal commits. */
  committedInset: number
  /** Settled pad retained after the route inset returns to zero. */
  lastSettledPad: number
  bottomInset: number
}

/** Bottom padding that keeps the composer glued to the top of the keyboard. */
export function resolveNativeChatBottomPad(input: NativeChatBottomPadInput): number {
  'worklet'
  const committedPad = input.committedInset + input.bottomInset
  // The route leads opening frames; only a dismissal needs the live frame.
  if (input.phase !== 'dismissing') {
    return committedPad
  }
  // The settled pad caps floating-keyboard top-edge measurements after route zeroes.
  const ceiling = Math.max(committedPad, input.lastSettledPad)
  return Math.max(Math.min(input.liveKeyboardHeight, ceiling), input.bottomInset)
}
