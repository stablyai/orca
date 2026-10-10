/** A save finished sealing after a later save or clear of the same credential had started. */
export class CredentialSaveSupersededError extends Error {
  constructor(credentialLabel: string) {
    super(`${credentialLabel} changed while it was being saved`)
    this.name = 'CredentialSaveSupersededError'
  }
}

export type CredentialWriteTurn = {
  /** Throws CredentialSaveSupersededError once a later save or clear of the credential started. */
  assertLatest(): void
}

/**
 * Keeps credential writes in call order now that sealing awaits the OS keychain: without it, a
 * save still sealing could land after a later clear and bring the cleared credential back.
 */
export class CredentialWriteOrder {
  private readonly latestTurns = new Map<string, number>()
  private turnCount = 0
  private clearedAllAtTurn = 0

  constructor(private readonly credentialLabel: string) {}

  /** Call synchronously when a save or clear of `key` starts, before its first await. */
  begin(key = ''): CredentialWriteTurn {
    const turn = ++this.turnCount
    this.latestTurns.set(key, turn)
    return {
      assertLatest: () => {
        if (this.latestTurns.get(key) !== turn || this.clearedAllAtTurn > turn) {
          throw new CredentialSaveSupersededError(this.credentialLabel)
        }
      }
    }
  }

  /** For a clear that drops every credential of the store at once. */
  beginClearAll(): void {
    this.clearedAllAtTurn = ++this.turnCount
  }
}
