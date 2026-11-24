type ParkedMs = { bulk: number; urgent: number }

/** A drain waiting for WAL room holds one admission per class, and urgent work wakes it early. */
export class JournalSqlWalParking {
  private readonly admissions = new Map<boolean, Promise<void>>()
  private wake: (() => void) | undefined
  private parked: { urgent: boolean; at: number } | undefined
  private readonly parkedMs: ParkedMs = { bulk: 0, urgent: 0 }

  constructor(private readonly gate: { beforeWrite(urgent: boolean): Promise<void> }) {}

  async park(urgent: boolean): Promise<void> {
    if (!this.admissions.has(urgent)) {
      const admission = this.gate.beforeWrite(urgent)
      this.admissions.set(urgent, admission)
      // One callback per admission: it wakes whichever park is current when the gate opens.
      const admitted = () => {
        this.admissions.delete(urgent)
        this.wake?.()
      }
      void admission.then(admitted, admitted)
    }
    const woken = Promise.withResolvers<void>()
    this.wake = woken.resolve
    this.parked = { urgent, at: performance.now() }
    await woken.promise
    this.wake = undefined
    this.parkedMs[urgent ? 'urgent' : 'bulk'] += performance.now() - this.parked.at
    this.parked = undefined
  }

  /** Urgent work arrived: a drain parked behind bulk picks its head again. */
  interrupt(): void {
    this.wake?.()
  }

  /** Parked time per class so far, including a park in progress; a request's share is the difference. */
  mark(): ParkedMs {
    const marked = { ...this.parkedMs }
    if (this.parked) {
      marked[this.parked.urgent ? 'urgent' : 'bulk'] += performance.now() - this.parked.at
    }
    return marked
  }
}
