import { SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS } from '../ipc/pty/delivery/visibility-state'

/**
 * Why main stopped a PTY on purpose. Both kinds keep the pane's binding through the exit:
 * - `reversible`: sleep or hibernation; the binding is the wake hint.
 * - `replaced`: a restart stops the old process so a new one can take the pane.
 */
export type TerminalIntentionalStopKind = 'reversible' | 'replaced'

type IntentionalStop = {
  kind: TerminalIntentionalStopKind
  /** Null until known; the first exit that claims the stop pins it to that process. */
  incarnationId: string | null
  owners: number
  stopped: boolean
  expiryTimer?: ReturnType<typeof setTimeout>
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
    const joinsInFlightStop =
      stop !== undefined &&
      stop.owners > 0 &&
      (stop.incarnationId === null ||
        incarnationId === null ||
        stop.incarnationId === incarnationId)
    if (stop && joinsInFlightStop) {
      stop.kind = kind
      stop.incarnationId ??= incarnationId
      stop.owners += 1
    } else {
      clearTimeout(stop?.expiryTimer)
      stop = { kind, incarnationId, owners: 1, stopped: false }
      this.stopsByPtyId.set(ptyId, stop)
    }
    const owned = stop
    let settled = false
    return (stopped) => {
      if (settled || this.stopsByPtyId.get(ptyId) !== owned) {
        return
      }
      settled = true
      owned.stopped ||= stopped
      owned.owners -= 1
      if (owned.owners > 0) {
        return
      }
      if (!owned.stopped) {
        this.stopsByPtyId.delete(ptyId)
        return
      }
      // Why a window: an SSH exit can arrive after the stop settles, and a synthetic exit can be
      // followed by the provider's own; both describe the same stopped process.
      owned.expiryTimer = setTimeout(() => {
        if (this.stopsByPtyId.get(ptyId) === owned) {
          this.stopsByPtyId.delete(ptyId)
        }
      }, SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS)
      owned.expiryTimer.unref?.()
    }
  }

  /** The kind of stop this exit ends, or null when the process was not stopped on purpose. */
  claimExit(
    ptyId: string,
    exitIncarnationId: string | null | undefined
  ): TerminalIntentionalStopKind | null {
    const stop = this.stopsByPtyId.get(ptyId)
    if (!stop) {
      return null
    }
    if (stop.incarnationId && exitIncarnationId && stop.incarnationId !== exitIncarnationId) {
      return null
    }
    stop.incarnationId ??= exitIncarnationId ?? null
    return stop.kind
  }

  /** Whether a stop of this PTY that may still be undone is in flight. */
  isReversibleStopInFlight(ptyId: string): boolean {
    const stop = this.stopsByPtyId.get(ptyId)
    return stop?.kind === 'reversible' && stop.owners > 0
  }
}
