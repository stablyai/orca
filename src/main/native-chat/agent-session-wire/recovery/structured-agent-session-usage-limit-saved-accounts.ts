// Where one home holds several saved accounts (agy's), a limited chat moves when the selected saved
// account is another than the one its cut hit. Each account's last known reset is kept, so moving
// to an account still out of quota waits for that account instead of releasing at once.

/** A move to another saved account in the same home; `limitedUntil` when that account is still out. */
export type UsageLimitSavedAccountMove = { account: string; limitedUntil?: number }

export class UsageLimitSavedAccountResets {
  private readonly resets = new Map<string, number>()

  /** The cut on `hit` resets at `resetsAt`; a later reset for the same account wins. */
  note(provider: string, hit: string | undefined, resetsAt: number | undefined): void {
    if (hit === undefined || resetsAt === undefined || !Number.isFinite(resetsAt)) {
      return
    }
    const key = JSON.stringify([provider, hit])
    this.resets.set(key, Math.max(this.resets.get(key) ?? resetsAt, resetsAt))
  }

  /** The move a chat makes now, or null when its launch would run on the account its cut hit. */
  move(
    provider: string,
    hit: string | undefined,
    selected: string | undefined,
    now: number
  ): UsageLimitSavedAccountMove | null {
    if (hit === undefined || selected === undefined || hit === selected) {
      return null
    }
    const until = this.resets.get(JSON.stringify([provider, selected]))
    return until !== undefined && until > now
      ? { account: selected, limitedUntil: until }
      : { account: selected }
  }

  clear(): void {
    this.resets.clear()
  }
}
