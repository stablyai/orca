// zcode's completion events answer with the started turn's input id, which is what tells a
// background task's turn apart from the chat's own: a background completion settles only its
// registration and never ends the foreground turn.

export class ZcodeTurnAttribution {
  /** Every started turn's input id → its key. */
  private readonly keysByInputId = new Map<string, string>()
  /** Turns started as background tasks; their completion never ends the foreground turn. */
  private readonly backgroundKeys = new Set<string>()

  started(inputMessageId: string | null, turnKey: string | null, isBackground: boolean): void {
    if (turnKey === null || inputMessageId === null) {
      return
    }
    this.keysByInputId.set(inputMessageId, turnKey)
    if (isBackground) {
      this.backgroundKeys.add(turnKey)
    }
  }

  /**
   * The background turn key this completion settles, or null when it belongs to the chat's own
   * foreground turn. Unattributed events fall through to the foreground — a bare completed is
   * the foreground's, since background starts record their input ids when zcode carries them.
   */
  settledBackgroundTurn(inputId: string | null): string | null {
    if (inputId === null) {
      return null
    }
    const turnKey = this.keysByInputId.get(inputId)
    if (turnKey === undefined || !this.backgroundKeys.has(turnKey)) {
      return null
    }
    this.backgroundKeys.delete(turnKey)
    this.keysByInputId.delete(inputId)
    return turnKey
  }
}
