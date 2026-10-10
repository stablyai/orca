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
 */

import { asWireRecord } from './realtime-wire-record'

type RealtimeEvent = Record<string, unknown>

export type ResponseGateSendOutcome = 'sent' | 'queued'

export type ResponseGateCreateOutcome = 'sent' | 'requeued' | 'failed'

export type ResponseGateObserver = {
  recordCreateOutcome(outcome: ResponseGateCreateOutcome, queuedWaitMs: number | null): void
}

const ACTIVE_RESPONSE_REJECTION = 'conversation_already_has_active_response'

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

export class RealtimeResponseGate {
  private pending: { event: RealtimeEvent; ref: string; enqueuedAt: number } | null = null
  private queue: { event: RealtimeEvent; ref: string; enqueuedAt: number }[] = []
  private activeResponseIds = new Set<string>()
  private mutedRejectionStreak = 0

  constructor(
    private readonly send: (event: RealtimeEvent) => void,
    private readonly observer: ResponseGateObserver,
    private readonly clock: () => number = () => Date.now()
  ) {}

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
    const entry = { event, ref, enqueuedAt: this.clock() }
    if (this.pending !== null || this.activeResponseIds.size > 0) {
      this.queue.push(entry)
      return { outcome: 'queued', ref }
    }
    this.pending = entry
    this.send(event)
    this.observer.recordCreateOutcome('sent', null)
    return { outcome: 'sent', ref }
  }

  /** Feed every inbound sideband event. */
  observe(event: RealtimeEvent): void {
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
