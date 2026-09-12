import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import type { StartedPortForward } from './ssh-port-forward-provider'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from '../../shared/relay-owner-reset-contract'

type ForwardDrain = ReturnType<NonNullable<StartedPortForward['fenceForDrain']>>
type RetainedForward = { forward: StartedPortForward; drain?: ForwardDrain; captured: boolean }
export type ForwardStartReservation = {
  start: (operation: () => Promise<StartedPortForward>) => Promise<StartedPortForward>
  release: () => void
}

/** Uncertain instances remain retained; only explicit complete-retirement receipts allow pruning. */
export class SshPortForwardRetirementCohort {
  private readonly forwards = new Map<StartedPortForward, RetainedForward>()
  private readonly failureSignal = new AbortController()
  private readonly startups = new TransportPublicationDrain(() => {})
  private readonly evidence = new TransportPublicationDrain(
    () => {},
    (error) => this.failureSignal.abort(error)
  )
  private fenced = false
  private revision = 0
  private drainedRevision = -1
  private starting = 0

  constructor(private readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('ssh_port_forward_retirement_capacity_invalid')
    }
  }

  async start(operation: () => Promise<StartedPortForward>): Promise<StartedPortForward> {
    const reservation = this.reserveStart()
    try {
      return await reservation.start(operation)
    } finally {
      reservation.release()
    }
  }

  reserveStart(): ForwardStartReservation {
    this.assertAdmission()
    this.pruneRetired()
    if (this.forwards.size + this.starting >= this.capacity) {
      throw new Error('ssh_port_forward_retirement_capacity_exhausted')
    }
    this.starting++
    const settle = this.startups.trackWrite()
    let released = false
    let publishing = false
    let published = false
    return {
      start: async (operation) => {
        if (released || publishing || published) {
          throw new Error('ssh_port_forward_start_reservation_consumed')
        }
        publishing = true
        try {
          const forward = await operation()
          this.register(forward)
          published = true
          return forward
        } finally {
          publishing = false
        }
      },
      release: () => {
        if (publishing) {
          throw new Error('ssh_port_forward_start_reservation_pending')
        }
        if (!released) {
          released = true
          this.starting--
          settle({ ok: true })
        }
      }
    }
  }

  get isEmpty(): boolean {
    return this.forwards.size === 0 && this.starting === 0
  }

  /** Observes existing receipts without pruning or manufacturing retirement evidence. */
  assertAbsent(): void {
    this.evidence.assertCurrent()
    const revision = this.revision
    if (this.starting || this.fenced) {
      throw new Error('ssh_port_forward_retirement_still_retained')
    }
    for (const forward of this.forwards.keys()) {
      if (forward.retirementConfirmed !== true) {
        throw new Error('ssh_port_forward_retirement_still_retained')
      }
    }
    this.evidence.assertCurrent()
    if (revision !== this.revision || this.starting || this.fenced) {
      throw new Error('ssh_port_forward_retirement_changed')
    }
  }

  assertAdmission(): void {
    if (this.fenced) {
      throw new Error('ssh_port_forward_admission_closed')
    }
  }

  fail(error: Error): void {
    this.evidence.fail(error)
  }

  pruneRetired(): void {
    for (const [forward] of this.forwards) {
      try {
        if (forward.retirementConfirmed === true) {
          this.forwards.delete(forward)
          const wasDrained = this.drainedRevision === this.revision
          this.revision++
          if (wasDrained) {
            this.drainedRevision = this.revision
          }
        }
      } catch (error) {
        this.fail(asError(error))
      }
    }
  }

  assertReconciled(): void {
    this.pruneRetired()
    this.evidence.assertCurrent()
    if (!this.isEmpty) {
      throw new Error('ssh_port_forward_retirement_reconciliation_required')
    }
  }

  reconcileResetRetirement(request: RelayOwnerResetRequest): void {
    const expected = parseRelayOwnerResetRequest(request)
    this.evidence.assertCurrent()
    this.startups.assertDrained()
    if (!this.fenced) {
      throw new Error('ssh_port_forward_reset_not_fenced')
    }
    const selected = [...this.forwards.keys()]
    const revision = this.revision
    for (const forward of selected) {
      if (forward.retirementConfirmed === true) {
        continue
      }
      const receipt = parseRelayOwnerResetRequest(forward.resetRetirementConfirmed)
      if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
        throw new Error('ssh_port_forward_reset_receipt_mismatch')
      }
    }
    this.evidence.assertCurrent()
    this.startups.assertDrained()
    if (this.revision !== revision) {
      throw new Error('ssh_port_forward_reset_selection_changed')
    }
    for (const forward of selected) {
      this.forwards.delete(forward)
    }
    this.revision++
    this.drainedRevision = this.revision
    this.assertReconciled()
  }

  assertResetRetirementSupported(): void {
    this.evidence.assertCurrent()
    this.startups.assertDrained()
    if (!this.fenced) {
      throw new Error('ssh_port_forward_reset_not_fenced')
    }
    for (const { forward } of this.forwards.values()) {
      if (forward.supportsResetRetirement !== true) {
        throw new Error('ssh_port_forward_reset_capability_unavailable')
      }
    }
  }

  register(forward: StartedPortForward): void {
    this.pruneRetired()
    if (this.forwards.has(forward)) {
      return
    }
    const retained = { forward, captured: false }
    this.forwards.set(forward, retained)
    this.revision++
    if (this.fenced) {
      this.capture(retained)
    }
  }

  fenceForDrain() {
    this.pruneRetired()
    this.fenced = true
    for (const retained of this.forwards.values()) {
      this.capture(retained)
    }
    return {
      drain: (signal: AbortSignal) => this.drain(signal),
      assertDrained: () => {
        this.evidence.assertCurrent()
        this.startups.assertDrained()
        const revision = this.revision
        if (this.drainedRevision !== revision) {
          throw new Error('ssh_port_forward_retirement_not_drained')
        }
        this.assertCapturedDrains()
        if (this.revision !== revision) {
          throw new Error('ssh_port_forward_retirement_not_drained')
        }
      }
    }
  }

  private capture(retained: RetainedForward): void {
    if (retained.captured) {
      return
    }
    retained.captured = true
    try {
      if (!retained.forward.fenceForDrain) {
        throw new Error('ssh_port_forward_retirement_capability_unavailable')
      }
      retained.drain = retained.forward.fenceForDrain()
      if (
        !retained.drain ||
        typeof retained.drain.drain !== 'function' ||
        typeof retained.drain.assertDrained !== 'function'
      ) {
        throw new Error('ssh_port_forward_retirement_capability_unavailable')
      }
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private assertCapturedDrains(): void {
    const revision = this.revision
    try {
      for (const retained of this.forwards.values()) {
        retained.drain?.assertDrained()
        if (revision !== this.revision) {
          return
        }
      }
      this.evidence.assertCurrent()
    } catch (error) {
      this.fail(asError(error))
      throw error
    }
  }

  private async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.evidence.assertCurrent()
    const observer = new AbortController()
    const combined = AbortSignal.any([signal, observer.signal, this.failureSignal.signal])
    try {
      await this.startups.drain(combined)
      for (;;) {
        const revision = this.revision
        const pending = [...this.forwards.values()].map((retained) =>
          Promise.resolve()
            .then(() => retained.drain?.drain(combined))
            .catch((error) => {
              if (!combined.aborted || error !== combined.reason) {
                this.fail(asError(error))
              }
              throw error
            })
        )
        await waitForPromiseWithSignal(Promise.all(pending), combined)
        signal.throwIfAborted()
        this.evidence.assertCurrent()
        if (revision !== this.revision) {
          continue
        }
        this.assertCapturedDrains()
        if (revision === this.revision) {
          this.drainedRevision = revision
          return
        }
      }
    } catch (error) {
      if (!signal.aborted && !this.failureSignal.signal.aborted) {
        this.fail(asError(error))
      }
      throw error
    } finally {
      observer.abort()
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
