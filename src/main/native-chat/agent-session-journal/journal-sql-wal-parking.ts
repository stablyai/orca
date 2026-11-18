type ParkedMs = { bulk: number; urgent: number }

/** A drain waiting for WAL room holds one admission per class, and urgent work wakes it early. */
export class JournalSqlWalParking {
  private readonly admissions = new Map<boolean, Promise<void>>()
  private wake: (() => void) | undefined
  /** Time drains spent parked per class; a request's share is the difference since it queued. */
  readonly parkedMs: ParkedMs = { bulk: 0, urgent: 0 }

  constructor(private readonly gate: { beforeWrite(urgent: boolean): Promise<void> }) {}

  async park(urgent: boolean): Promise<void> {
    let admission = this.admissions.get(urgent)
    if (!admission) {
      admission = this.gate.beforeWrite(urgent).finally(() => this.admissions.delete(urgent))
      this.admissions.set(urgent, admission)
    }
    const woken = Promise.withResolvers<void>()
    this.wake = woken.resolve
    void admission.then(woken.resolve, woken.resolve)
    const parkedAt = performance.now()
    await woken.promise
    this.wake = undefined
    this.parkedMs[urgent ? 'urgent' : 'bulk'] += performance.now() - parkedAt
  }

  /** Urgent work arrived: a drain parked behind bulk picks its head again. */
  interrupt(): void {
    this.wake?.()
  }

  mark(): ParkedMs {
    return { ...this.parkedMs }
  }
}
