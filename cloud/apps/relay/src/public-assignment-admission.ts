type AssignmentAdmissionLease = { release(): void }
type CancelWait = () => void
// Per-call sink: acquire() keeps returning null so callers stay unchanged, and the
// reason rides out of band to whoever made this particular request.
type RejectionSink = (reason: AssignmentAdmissionRejection) => void
type PendingAssignment = {
  relayHostId: string
  resolve: (lease: AssignmentAdmissionLease | null) => void
  cancelWait: CancelWait
  notifyRejected?: RejectionSink
}

// Every rejection here becomes an identical 503, so without the reason a busy
// director and a self-throttling host are indistinguishable in production.
export type AssignmentAdmissionRejection =
  | 'host-in-flight'
  | 'host-rate-limited'
  | 'queue-full'
  | 'wait-timeout'
  | 'superseded'
  | 'reserved-unavailable'

const MAX_TRACKED_HOSTS = 4_096

export class RelayPublicAssignmentAdmission {
  private active = 0
  private activeReserved = 0
  private readonly activeAssignmentHosts = new Set<string>()
  private readonly activeReservedHosts = new Set<string>()
  private readonly queuedAssignmentHosts = new Set<string>()
  private readonly lastAttemptByHost = new Map<string, number>()
  private readonly lastReservedAttemptByHost = new Map<string, number>()
  private readonly pendingAssignments: PendingAssignment[] = []
  private pendingReserved: PendingAssignment | undefined

  constructor(
    private readonly options: {
      maxConcurrent: number
      maxQueued?: number
      waitMs?: number
      maxReservedConcurrent?: number
      reservedWaitMs?: number
      minIntervalMs: number
      now?: () => number
      schedule?: (callback: () => void, delayMs: number) => CancelWait
      onRejected?: (reason: AssignmentAdmissionRejection) => void
    }
  ) {}

  async acquire(
    relayHostId: string,
    notifyRejected?: RejectionSink
  ): Promise<AssignmentAdmissionLease | null> {
    const now = (this.options.now ?? Date.now)()
    const lastAttempt = this.lastAttemptByHost.get(relayHostId)
    if (
      this.activeAssignmentHosts.has(relayHostId) ||
      this.activeReservedHosts.has(relayHostId) ||
      this.queuedAssignmentHosts.has(relayHostId) ||
      this.pendingReserved?.relayHostId === relayHostId
    ) {
      return this.reject('host-in-flight', notifyRejected)
    }
    if (lastAttempt !== undefined && now - lastAttempt < this.options.minIntervalMs) {
      return this.reject('host-rate-limited', notifyRejected)
    }
    if (
      this.active < this.options.maxConcurrent &&
      this.pendingReserved === undefined &&
      this.pendingAssignments.length === 0
    ) {
      this.recordAttempt(this.lastAttemptByHost, relayHostId, now)
      return this.createLease(relayHostId, false)
    }
    if (this.pendingAssignments.length >= (this.options.maxQueued ?? 0)) {
      return this.reject('queue-full', notifyRejected)
    }

    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      let cancelWait: CancelWait = () => undefined
      const pending: PendingAssignment = {
        relayHostId,
        resolve,
        cancelWait: () => cancelWait(),
        notifyRejected
      }
      this.pendingAssignments.push(pending)
      this.queuedAssignmentHosts.add(relayHostId)
      cancelWait = schedule(() => {
        const index = this.pendingAssignments.indexOf(pending)
        if (index === -1) return
        this.pendingAssignments.splice(index, 1)
        this.queuedAssignmentHosts.delete(relayHostId)
        resolve(this.reject('wait-timeout', notifyRejected))
      }, this.options.waitMs ?? 1_000)
    })
  }

  async acquireReserved(
    relayHostId: string,
    notifyRejected?: RejectionSink
  ): Promise<AssignmentAdmissionLease | null> {
    const maxReservedConcurrent = this.options.maxReservedConcurrent ?? 0
    const now = (this.options.now ?? Date.now)()
    const lastAttempt = this.lastReservedAttemptByHost.get(relayHostId)
    if (maxReservedConcurrent === 0 || this.activeReserved >= maxReservedConcurrent) {
      return this.reject('reserved-unavailable', notifyRejected)
    }
    if (this.activeReservedHosts.has(relayHostId)) {
      return this.reject('host-in-flight', notifyRejected)
    }
    if (this.pendingReserved !== undefined) {
      return this.reject('reserved-unavailable', notifyRejected)
    }
    if (lastAttempt !== undefined && now - lastAttempt < this.options.minIntervalMs) {
      return this.reject('host-rate-limited', notifyRejected)
    }
    this.cancelQueuedAssignment(relayHostId)
    if (
      this.active < this.options.maxConcurrent &&
      !this.activeAssignmentHosts.has(relayHostId)
    ) {
      this.recordAttempt(this.lastReservedAttemptByHost, relayHostId, now)
      return this.createLease(relayHostId, true)
    }

    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      let cancelWait: CancelWait = () => undefined
      this.pendingReserved = {
        relayHostId,
        resolve,
        cancelWait: () => cancelWait(),
        notifyRejected
      }
      cancelWait = schedule(() => {
        if (this.pendingReserved?.relayHostId !== relayHostId) return
        this.pendingReserved = undefined
        resolve(this.reject('wait-timeout', notifyRejected))
        this.grantPendingAssignments()
      }, this.options.reservedWaitMs ?? 1_000)
    })
  }

  private createLease(relayHostId: string, reserved: boolean): AssignmentAdmissionLease {
    this.active++
    if (reserved) {
      this.activeReserved++
      this.activeReservedHosts.add(relayHostId)
    } else {
      this.activeAssignmentHosts.add(relayHostId)
    }
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        if (reserved) {
          this.activeReserved = Math.max(0, this.activeReserved - 1)
          this.activeReservedHosts.delete(relayHostId)
        } else {
          this.activeAssignmentHosts.delete(relayHostId)
        }
        this.grantPendingReserved()
        this.grantPendingAssignments()
      }
    }
  }

  private grantPendingReserved(): void {
    const pending = this.pendingReserved
    if (
      !pending ||
      this.active >= this.options.maxConcurrent ||
      this.activeAssignmentHosts.has(pending.relayHostId)
    ) {
      return
    }
    this.pendingReserved = undefined
    pending.cancelWait()
    this.recordAttempt(
      this.lastReservedAttemptByHost,
      pending.relayHostId,
      (this.options.now ?? Date.now)()
    )
    pending.resolve(this.createLease(pending.relayHostId, true))
  }

  private grantPendingAssignments(): void {
    while (
      this.pendingReserved === undefined &&
      this.active < this.options.maxConcurrent &&
      this.pendingAssignments.length > 0
    ) {
      const pending = this.pendingAssignments.shift()!
      this.queuedAssignmentHosts.delete(pending.relayHostId)
      pending.cancelWait()
      this.recordAttempt(
        this.lastAttemptByHost,
        pending.relayHostId,
        (this.options.now ?? Date.now)()
      )
      pending.resolve(this.createLease(pending.relayHostId, false))
    }
  }

  private cancelQueuedAssignment(relayHostId: string): void {
    const index = this.pendingAssignments.findIndex(
      (pending) => pending.relayHostId === relayHostId
    )
    if (index === -1) return
    const [pending] = this.pendingAssignments.splice(index, 1)
    this.queuedAssignmentHosts.delete(relayHostId)
    pending?.cancelWait()
    // The sink rides on the pending record: this rejects a different caller's request.
    pending?.resolve(this.reject('superseded', pending.notifyRejected))
  }

  private reject(reason: AssignmentAdmissionRejection, notifyRejected?: RejectionSink): null {
    this.options.onRejected?.(reason)
    notifyRejected?.(reason)
    return null
  }

  private recordAttempt(attempts: Map<string, number>, relayHostId: string, now: number): void {
    attempts.delete(relayHostId)
    attempts.set(relayHostId, now)
    if (attempts.size > MAX_TRACKED_HOSTS) {
      attempts.delete(attempts.keys().next().value!)
    }
  }
}

function defaultSchedule(callback: () => void, delayMs: number): CancelWait {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}
