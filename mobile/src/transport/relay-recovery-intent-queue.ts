// Recovery requests that arrive while the supervisor's operation mutex is held.
// Two latches, because the intents are not interchangeable: an owning forced
// replacement books the shared cooldown and may bring a stale session down, while
// every other request must replay as a plain recovery. Nothing is ever dropped.
export class RelayRecoveryIntentQueue {
  private replacement = false
  private recovery = false

  queue(forceReplacement: boolean, ownsRecovery: boolean): void {
    if (forceReplacement && ownsRecovery) {
      this.replacement = true
      return
    }
    this.recovery = true
  }

  holdReplacement(): void {
    this.replacement = true
  }

  hasReplacement(): boolean {
    return this.replacement
  }

  clearReplacement(): void {
    this.replacement = false
  }

  takeReplacement(): boolean {
    const queued = this.replacement
    this.replacement = false
    return queued
  }

  takeRecovery(): boolean {
    const queued = this.recovery
    this.recovery = false
    return queued
  }

  clear(): void {
    this.replacement = false
    this.recovery = false
  }
}
