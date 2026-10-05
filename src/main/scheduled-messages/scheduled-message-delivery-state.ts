/** In memory on purpose: a restart is a fresh chance, and persisting the count
 *  would strand a message against conditions that no longer exist. */
export class ScheduledMessageDeliveryState {
  private readonly attempts = new Map<string, number>()

  attemptsFor(messageId: string): number {
    return this.attempts.get(messageId) ?? 0
  }

  recordAttempt(messageId: string): void {
    this.attempts.set(messageId, this.attemptsFor(messageId) + 1)
  }

  forget(messageId: string): void {
    this.attempts.delete(messageId)
  }
}
