/**
 * Serializes backend-sent `response.create` events for one realtime session: the provider
 * runs one response at a time and rejects a create sent mid-response. Every create is
 * tagged with a unique ref (its `event_id`, echoed into `response.metadata.ref`) so
 * created/done answers are correlated, never guessed — a server-VAD response is not the
 * answer to our create. Errors matched by ref where the provider echoes it;
 * gpt-realtime-2.1 stopped echoing client event_ids on errors, so active-response
 * rejections (only ever about a create, and only ours is in flight) match by code.
 *
 * Port of otto-voice's ResponseGate. A queued create is never cancelled or coalesced:
 * cancelling would cut the user off mid-sentence.
 *
 * Stall recovery: a create that sees no response lifecycle progress within the stall
 * budget died on the wire (or its rejection did) — waiting longer wedges the session
 * with the mic open and the pill spinning. The gate re-sends it (bounded; then dropped)
 * so a lost turn costs seconds, not the session.
 */

import { asWireRecord } from './realtime-wire-record'

type RealtimeEvent = Record<string, unknown>

export type ResponseGateSendOutcome = 'sent' | 'queued'

export type ResponseGateCreateOutcome = 'sent' | 'requeued' | 'failed'

export type ResponseGateObserver = {
  recordCreateOutcome(outcome: ResponseGateCreateOutcome, queuedWaitMs: number | null): void
  /** A create sat unanswered past the stall budget and the gate force-resumed itself. */
  recordStallRecovery?(ref: string, attempt: number, dropped: boolean): void
}

/** Injectable so tests drive the stall timer synchronously. */
export type ResponseGateScheduler = {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

export type ResponseGateOptions = {
  /** Silence budget for an outstanding create before the gate re-sends it. 0 disables. */
  stallMs?: number
  scheduler?: ResponseGateScheduler
}

const ACTIVE_RESPONSE_REJECTION = 'conversation_already_has_active_response'

/** A create unanswered this long on a live socket died on the wire — waiting longer wedges the session. */
const DEFAULT_STALL_MS = 20_000
/** Per-create resend cap; past it the create is dropped so the session outlives the turn. */
const MAX_STALL_RECOVERIES = 2

const defaultScheduler: ResponseGateScheduler = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle)
}

let refCounter = 0

/** Stamps a create with its correlation ref; returns the ref for the caller's records. */
export function tagResponseCreate(event: RealtimeEvent): string {
  refCounter += 1
  const ref = `control-response-${refCounter}`
  event.event_id = ref
  const response = asWireRecord(event.response) ?? {}
  const metadata = asWireRecord(response.metadata) ?? {}
  metadata.ref = ref
  response.metadata = metadata
  event.response = response
  return ref
}

function readResponseRef(event: RealtimeEvent): string | null {
  const ref = asWireRecord(asWireRecord(event.response)?.metadata)?.ref
  return typeof ref === 'string' ? ref : null
}

type QueuedCreate = {
  event: RealtimeEvent
  ref: string
  enqueuedAt: number
  /** Stall-recovery resends so far — capped so a dead create can't loop forever. */
  recoveries: number
}

export class RealtimeResponseGate {
  private pending: QueuedCreate | null = null
  private queue: QueuedCreate[] = []
  private activeResponseIds = new Set<string>()
  private mutedRejectionStreak = 0
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private readonly stallMs: number
  private readonly scheduler: ResponseGateScheduler

  constructor(
    private readonly send: (event: RealtimeEvent) => void,
    private readonly observer: ResponseGateObserver,
    private readonly clock: () => number = () => Date.now(),
    options: ResponseGateOptions = {}
  ) {
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS
    this.scheduler = options.scheduler ?? defaultScheduler
  }

  /**
   * Every outbound sideband event goes through here; non-creates pass immediately.
   * Creates return their correlation ref alongside the outcome so callers can match the
   * eventual response.created/done back to this exact create.
   */
  sendEvent(event: RealtimeEvent): { outcome: ResponseGateSendOutcome; ref: string } | null {
    if (event.type !== 'response.create') {
      this.send(event)
      return null
    }
    const ref = tagResponseCreate(event)
    const entry: QueuedCreate = { event, ref, enqueuedAt: this.clock(), recoveries: 0 }
    if (this.pending !== null || this.activeResponseIds.size > 0) {
      this.queue.push(entry)
      this.syncStallTimer()
      return { outcome: 'queued', ref }
    }
    this.pending = entry
    this.send(event)
    this.observer.recordCreateOutcome('sent', null)
    this.syncStallTimer()
    return { outcome: 'sent', ref }
  }

  /** Feed every inbound sideband event. */
  observe(event: RealtimeEvent): void {
    try {
      this.observeEvent(event)
    } finally {
      this.syncStallTimer()
    }
  }

  private observeEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'response.created': {
        const id = asWireRecord(event.response)?.id
        if (typeof id === 'string') {
          this.activeResponseIds.add(id)
        }
        // Our pending create's answer, or a server-VAD response starting: either way the
        // create left the wire, so it is no longer ours to requeue on a later error.
        if (this.pending !== null && readResponseRef(event) === this.pending.ref) {
          this.pending = null
          this.mutedRejectionStreak = 0
        }
        return
      }
      case 'response.done': {
        const id = asWireRecord(event.response)?.id
        if (typeof id === 'string') {
          this.activeResponseIds.delete(id)
        }
        this.mutedRejectionStreak = 0
        // A done that empties the active set also settles a create whose created never
        // echoed our ref (unanswerable from the wire): either that response WAS ours, or
        // our create died with the cycle. Wedging the queue behind it is the worse option;
        // a late rejection still self-heals via the requeue path.
        if (this.activeResponseIds.size === 0) {
          this.pending = null
        }
        this.flushQueue()
        return
      }
      case 'error': {
        if (this.pending === null) {
          return
        }
        const errorRecord = asWireRecord(event.error)
        const message = errorRecord?.message
        const isActiveRejection =
          (typeof errorRecord?.code === 'string' &&
            errorRecord.code === ACTIVE_RESPONSE_REJECTION) ||
          (typeof message === 'string' && message.includes(ACTIVE_RESPONSE_REJECTION))
        // Why two matches: the ref echo (error.event_id === our create's event_id) was
        // live-confirmed on gpt-realtime, but gpt-realtime-2.1 errors carry a
        // server-side event_* id instead. An active-response rejection can only be
        // about a create, and this socket's only in-flight create IS the pending one —
        // so those match by code, or the relay they reject vanishes silently (live:
        // the second agent's update was dropped this way).
        if (event.event_id !== this.pending.ref && !isActiveRejection) {
          return
        }
        const rejected = this.pending
        this.pending = null
        if (isActiveRejection) {
          // Rejected because a foreign response is active: back to the head of the queue.
          this.queue.unshift(rejected)
          this.observer.recordCreateOutcome('requeued', this.clock() - rejected.enqueuedAt)
          this.mutedRejectionStreak += 1
          // Repeated rejections mean the provider state is confused; stop hammering and
          // let the next response.done or send resume the queue in order.
          if (this.mutedRejectionStreak < 3) {
            this.flushQueue()
          }
        } else {
          // Any other rejection kills the create, but tells us nothing about provider
          // state — a response may still be running. Never re-send blindly; the queue
          // resumes on the next response.done.
          this.observer.recordCreateOutcome('failed', this.clock() - rejected.enqueuedAt)
        }
      }
    }
  }

  get queuedCount(): number {
    return this.queue.length + (this.pending === null ? 0 : 1)
  }

  /** Stops the stall timer; the session teardown owns the call. */
  dispose(): void {
    this.disarmStallTimer()
  }

  /**
   * Armed while any create is outstanding (pending or queued). Not reset by unrelated
   * events — the budget is "silence toward this create", not "socket quiet".
   */
  private syncStallTimer(): void {
    if (this.stallMs <= 0) {
      return
    }
    if (this.pending === null && this.queue.length === 0) {
      this.disarmStallTimer()
      return
    }
    if (this.stallTimer === null) {
      this.stallTimer = this.scheduler.setTimeout(() => this.onStall(), this.stallMs)
    }
  }

  private disarmStallTimer(): void {
    if (this.stallTimer !== null) {
      this.scheduler.clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  private onStall(): void {
    this.stallTimer = null
    if (this.pending !== null) {
      const stalled = this.pending
      stalled.recoveries += 1
      if (stalled.recoveries > MAX_STALL_RECOVERIES) {
        // The provider will never answer this create — drop it so the turns behind it
        // can move; the session outlives the lost answer.
        this.pending = null
        this.observer.recordStallRecovery?.(stalled.ref, stalled.recoveries, true)
        this.observer.recordCreateOutcome('failed', this.clock() - stalled.enqueuedAt)
        this.flushQueue()
      } else {
        this.observer.recordStallRecovery?.(stalled.ref, stalled.recoveries, false)
        // Resend from the head: the first send died unacknowledged. Active ids may be
        // zombies (their done never arrived) — cleared so the resend can go; if one was
        // real, the rejection comes back as active-response and the requeue self-heals.
        this.pending = null
        this.activeResponseIds.clear()
        this.mutedRejectionStreak = 0
        this.queue.unshift(stalled)
        this.flushQueue()
      }
    } else if (this.queue.length > 0 && this.activeResponseIds.size === 0) {
      // A wedged flush — no response is active yet the queue never moved.
      this.flushQueue()
    }
    // Queued behind a genuinely active response is normal flow, not a stall.
    this.syncStallTimer()
  }

  private flushQueue(): void {
    if (this.pending !== null || this.activeResponseIds.size > 0) {
      return
    }
    const next = this.queue.shift()
    if (!next) {
      return
    }
    this.pending = next
    this.send(next.event)
    this.observer.recordCreateOutcome('sent', this.clock() - next.enqueuedAt)
  }
}
