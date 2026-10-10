/**
 * Main hands a hidden local daemon PTY's query replies to the daemon (#27023 phase 2).
 *
 * A view-gated PTY's queries are main's to answer, which keeps main's model parsing every
 * hidden pane. The daemon parses the same bytes, so main asks it to answer instead. The
 * daemon's marker lands in byte order and flips the gate; until then main (or, when main's
 * model is dormant, the view) keeps answering, and after it main's model may go dormant.
 * Taking replies back waits for the daemon's marker the same way, with the view still gated.
 */

// Why: an unconfirmed request leaves the hidden view parsing bytes; past this main answers again.
export const DAEMON_QUERY_RESPONDER_CONFIRM_TIMEOUT_MS = 2_000

export type DaemonQueryResponderDelegationHost = {
  lifecycleGeneration(ptyId: string): number
  isHidden(ptyId: string): boolean
  /** Hidden, and the daemon could answer while nothing needs main's model. */
  shouldDelegate(ptyId: string): boolean
  /** Sends the request to the PTY's daemon; false when it could not be sent. */
  send(ptyId: string, responder: boolean): boolean
  /** While pending, the view answers until the daemon confirms, unless main's model can. */
  setHandoffPending(ptyId: string, pending: boolean): void
  /** Wakes main's model for a hidden PTY main will answer again. True once that model has
   *  caught up, or when main will not be the responder. */
  reclaim(ptyId: string): boolean
}

type DelegationEntry = {
  generation: number
  requested: boolean
  confirmed: boolean
  inFlight: number
  gaveUp: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class DaemonQueryResponderDelegation {
  private readonly entries = new Map<string, DelegationEntry>()

  constructor(private readonly host: DaemonQueryResponderDelegationHost) {}

  /** On every hidden mark, unmark and live chunk: delegate when eligible, take back when not. */
  sync(ptyId: string): void {
    const existing = this.currentEntry(ptyId)
    if (!existing?.requested && !this.host.isHidden(ptyId)) {
      return
    }
    const wanted = this.host.shouldDelegate(ptyId)
    if (wanted && !existing?.requested) {
      this.request(ptyId, existing ?? this.entryFor(ptyId))
    } else if (!wanted && existing?.requested) {
      // Why wait: the daemon stays a hidden PTY's responder until main's woken model has caught
      // up, so no byte falls to a view that may have stopped parsing.
      if (this.host.isHidden(ptyId) && !this.host.reclaim(ptyId)) {
        return
      }
      this.takeBack(ptyId, existing)
    }
  }

  isRequested(ptyId: string): boolean {
    return this.currentEntry(ptyId)?.requested === true
  }

  /** The daemon's in-order marker, after the gate applied it. */
  noteMarker(ptyId: string, responder: boolean): void {
    const entry = this.currentEntry(ptyId)
    if (!entry) {
      // Why: a request that outlived its PTY generation reached the respawned session.
      if (responder) {
        this.host.send(ptyId, false)
      }
      return
    }
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    entry.confirmed = responder
    if (responder) {
      this.clearTimer(entry)
      // Why: a late confirmation after a give-up or a take-back still in flight.
      if (!entry.requested && entry.inFlight === 0) {
        this.sendTracked(ptyId, entry, false)
      }
      return
    }
    // Why: an unrequested take-back means the daemon dropped the delegation (a reattach); the
    // view answers meanwhile, so asking again needs no wake.
    if (entry.requested && entry.inFlight === 0) {
      this.clearTimer(entry)
      if (this.sendTracked(ptyId, entry, true)) {
        this.armTimer(ptyId, entry)
      } else {
        this.giveUp(ptyId, entry)
      }
    }
  }

  forget(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) {
      this.clearTimer(entry)
      this.entries.delete(ptyId)
    }
  }

  private request(ptyId: string, entry: DelegationEntry): void {
    if (entry.gaveUp || !this.sendTracked(ptyId, entry, true)) {
      entry.gaveUp = true
      return
    }
    entry.requested = true
    this.host.setHandoffPending(ptyId, true)
    this.armTimer(ptyId, entry)
  }

  private takeBack(ptyId: string, entry: DelegationEntry): void {
    entry.requested = false
    this.clearTimer(entry)
    this.host.setHandoffPending(ptyId, false)
    this.sendTracked(ptyId, entry, false)
  }

  private giveUp(ptyId: string, entry: DelegationEntry): void {
    entry.gaveUp = true
    this.takeBack(ptyId, entry)
    this.reclaimIfHidden(ptyId)
  }

  // Why hidden only: a revealed view answers once the daemon lets go, so it needs no model.
  private reclaimIfHidden(ptyId: string): void {
    if (this.host.isHidden(ptyId)) {
      this.host.reclaim(ptyId)
    }
  }

  private sendTracked(ptyId: string, entry: DelegationEntry, responder: boolean): boolean {
    const sent = this.host.send(ptyId, responder)
    if (sent) {
      entry.inFlight += 1
    }
    return sent
  }

  private armTimer(ptyId: string, entry: DelegationEntry): void {
    this.clearTimer(entry)
    const timer = setTimeout(() => {
      if (this.currentEntry(ptyId) === entry && entry.timer === timer) {
        entry.timer = null
        if (entry.requested && !entry.confirmed) {
          this.giveUp(ptyId, entry)
        }
      }
    }, DAEMON_QUERY_RESPONDER_CONFIRM_TIMEOUT_MS)
    timer.unref?.()
    entry.timer = timer
  }

  private clearTimer(entry: DelegationEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  private currentEntry(ptyId: string): DelegationEntry | null {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return null
    }
    if (entry.generation !== this.host.lifecycleGeneration(ptyId)) {
      this.forget(ptyId)
      return null
    }
    return entry
  }

  private entryFor(ptyId: string): DelegationEntry {
    const entry: DelegationEntry = {
      generation: this.host.lifecycleGeneration(ptyId),
      requested: false,
      confirmed: false,
      inFlight: 0,
      gaveUp: false,
      timer: null
    }
    this.entries.set(ptyId, entry)
    return entry
  }
}
