const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

/** Tracks the focus report a ?1004 program last received, so losing every viewer reports focus-out once. */
export class SessionFocusReport {
  // The arming that last heard ESC [ O; null once ESC [ I follows or nothing was reported to it.
  private focusOutArming: number | null = null

  observeInput(data: string, arming: number | null): void {
    const focusOutAt = data.lastIndexOf(FOCUS_OUT)
    const focusInAt = data.lastIndexOf(FOCUS_IN)
    if (focusOutAt > focusInAt) {
      this.focusOutArming = arming
    } else if (focusInAt > focusOutAt) {
      this.focusOutArming = null
    }
  }

  /** The focus-out a vanished viewer never sent, or null when the program is unarmed or already told. */
  takeFocusLoss(arming: number | null): string | null {
    if (arming === null || this.focusOutArming === arming) {
      return null
    }
    this.focusOutArming = arming
    return FOCUS_OUT
  }
}
