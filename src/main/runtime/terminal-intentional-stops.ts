import { SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS } from '../ipc/pty/delivery/visibility-state'

/** Preserve pane bindings across intentional exits: reversible keeps a wake hint; replaced awaits immediate or reconnect-time replacement. */
export type TerminalIntentionalStopKind = 'reversible' | 'replaced'

type IntentionalStopOwners = { inFlight: number; stopped: boolean }

type IntentionalStop = {
  /** Null until known; the first exit that claims the stop pins it to that process. */
  incarnationId: string | null
  /** Why per kind: overlapping stops of different kinds each hold their own label on the exit. */
  ownersByKind: Map<TerminalIntentionalStopKind, IntentionalStopOwners>
  release?: Promise<void>
  expiryTimer?: ReturnType<typeof setTimeout>
}

export type TerminalIntentionalStopOwner = ((stopped: boolean) => void) & {
  joinRelease: () => Promise<void> | undefined
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
  ): TerminalIntentionalStopOwner {
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
    const settle = (stopped: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      owners.stopped ||= stopped
      owners.inFlight -= 1
      if (owners.inFlight === 0 && !owners.stopped) {
        owned.ownersByKind.delete(kind)
      }
      if (!hasInFlightOwners(owned)) {
        owned.release = undefined
      }
      if (this.stopsByPtyId.get(ptyId) === owned) {
        this.settleIfIdle(ptyId, owned)
      }
    }
    return Object.assign(settle, { joinRelease: () => owned.release })
  }

  /** Capture the operation before callbacks can replace its PTY id. Ordinary exits retain no completion. */
  captureExitRelease(
    ptyId: string,
    incarnationId: string | null | undefined
  ): (release: Promise<void>) => void {
    const stop = this.stopsByPtyId.get(ptyId)
    if (
      !stop ||
      !hasInFlightOwners(stop) ||
      (stop.incarnationId && incarnationId && stop.incarnationId !== incarnationId)
    ) {
      return () => {}
    }
    stop.incarnationId ??= incarnationId ?? null
    return (release) => {
      if (hasInFlightOwners(stop)) {
        stop.release = stop.release ? Promise.all([stop.release, release]).then(() => {}) : release
      }
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

  /** Clear an unpinned landed stop at spawn commit so a reused PTY id cannot claim the new process's exit. */
  noteSpawnCommit(ptyId: string): void {
    const stop = this.stopsByPtyId.get(ptyId)
    if (stop && stop.incarnationId === null && !hasInFlightOwners(stop)) {
      clearTimeout(stop.expiryTimer)
      this.stopsByPtyId.delete(ptyId)
    }
  }

  // Settled stops join only their known incarnation; reused ids with unknown identity must not inherit old stops.
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
    // Keep a window for delayed SSH exits and duplicate synthetic/provider exits from the same process.
    stop.expiryTimer = setTimeout(() => {
      if (this.stopsByPtyId.get(ptyId) === stop) {
        this.stopsByPtyId.delete(ptyId)
      }
    }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
    stop.expiryTimer.unref?.()
  }
}
