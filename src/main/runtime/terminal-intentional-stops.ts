import { SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS } from '../ipc/pty/delivery/visibility-state'

/**
 * Why main stopped a PTY on purpose. Both kinds keep the pane's binding through the exit:
 * - `reversible`: sleep or hibernation; the binding is the wake hint.
 * - `replaced`: a restart stops the old process so a new one can take the pane.
 */
export type TerminalIntentionalStopKind = 'reversible' | 'replaced'

type IntentionalStopOwners = { inFlight: number; stopped: boolean }

type IntentionalStop = {
  /** Null until known; the first exit that claims the stop pins it to that process. */
  incarnationId: string | null
  /** Why per kind: overlapping stops of different kinds each hold their own label on the exit. */
  ownersByKind: Map<TerminalIntentionalStopKind, IntentionalStopOwners>
  expiryTimer?: ReturnType<typeof setTimeout>
}

const NO_INTENTIONAL_STOP: readonly TerminalIntentionalStopKind[] = []

function hasInFlightOwners(stop: IntentionalStop): boolean {
  return [...stop.ownersByKind.values()].some((owners) => owners.inFlight > 0)
}

/** The one register of PTY stops main made on purpose, read by every exit path. */
export class TerminalIntentionalStops {
  private readonly stopsByPtyId = new Map<string, IntentionalStop>()

  /** Registers one owner's stop; call the result once with whether the stop landed. */
  mark(
    ptyId: string,
    kind: TerminalIntentionalStopKind,
    incarnationId: string | null
  ): (stopped: boolean) => void {
    let stop = this.stopsByPtyId.get(ptyId)
    if (stop && this.joins(stop, incarnationId)) {
      clearTimeout(stop.expiryTimer)
      stop.expiryTimer = undefined
      stop.incarnationId ??= incarnationId
    } else {
      clearTimeout(stop?.expiryTimer)
      stop = { incarnationId, ownersByKind: new Map() }
      this.stopsByPtyId.set(ptyId, stop)
    }
    const owners = stop.ownersByKind.get(kind) ?? { inFlight: 0, stopped: false }
    owners.inFlight += 1
    stop.ownersByKind.set(kind, owners)
    const owned = stop
    let settled = false
    return (stopped) => {
      if (settled || this.stopsByPtyId.get(ptyId) !== owned) {
        return
      }
      settled = true
      owners.stopped ||= stopped
      owners.inFlight -= 1
      if (owners.inFlight === 0 && !owners.stopped) {
        owned.ownersByKind.delete(kind)
      }
      this.settleIfIdle(ptyId, owned)
    }
  }

  /** The kinds of stop this exit ends; empty when the process was not stopped on purpose. */
  claimExit(
    ptyId: string,
    exitIncarnationId: string | null | undefined
  ): readonly TerminalIntentionalStopKind[] {
    const stop = this.stopsByPtyId.get(ptyId)
    if (!stop) {
      return NO_INTENTIONAL_STOP
    }
    if (stop.incarnationId && exitIncarnationId && stop.incarnationId !== exitIncarnationId) {
      return NO_INTENTIONAL_STOP
    }
    stop.incarnationId ??= exitIncarnationId ?? null
    return [...stop.ownersByKind.keys()]
  }

  /** Whether a stop of this PTY that may still be undone is in flight. */
  isReversibleStopInFlight(ptyId: string): boolean {
    return (this.stopsByPtyId.get(ptyId)?.ownersByKind.get('reversible')?.inFlight ?? 0) > 0
  }

  /** A process committed on this id. A landed stop's process is dead, so an entry no exit ever
   *  pinned could otherwise claim the new process's exit as the stop. */
  noteSpawnCommit(ptyId: string): void {
    const stop = this.stopsByPtyId.get(ptyId)
    if (stop && stop.incarnationId === null && !hasInFlightOwners(stop)) {
      clearTimeout(stop.expiryTimer)
      this.stopsByPtyId.delete(ptyId)
    }
  }

  // Why: a settled entry joins only its own known process, so an id reused by a process whose
  // incarnation is not yet known never inherits the old stop.
  private joins(stop: IntentionalStop, incarnationId: string | null): boolean {
    if (stop.incarnationId !== null && stop.incarnationId === incarnationId) {
      return true
    }
    return hasInFlightOwners(stop) && (stop.incarnationId === null || incarnationId === null)
  }

  private settleIfIdle(ptyId: string, stop: IntentionalStop): void {
    if (hasInFlightOwners(stop)) {
      return
    }
    if (stop.ownersByKind.size === 0) {
      this.stopsByPtyId.delete(ptyId)
      return
    }
    // Why a window: an SSH exit can arrive after the stop settles, and a synthetic exit can be
    // followed by the provider's own; both describe the same stopped process.
    stop.expiryTimer = setTimeout(() => {
      if (this.stopsByPtyId.get(ptyId) === stop) {
        this.stopsByPtyId.delete(ptyId)
      }
    }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
    stop.expiryTimer.unref?.()
  }
}
