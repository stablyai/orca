/** Suppress hidden-pane IPC and reread the relay screen on reveal; main has no terminal model. COMPAT(legacy-relay-bridge): revisit 2027-01-15. */
import {
  EMPTY_OUTPUT_SALVAGE,
  salvageHiddenOutput,
  type OutputSalvageState
} from './legacy-relay-output-salvage'

type LegacyRelayHiddenOutputDeps = {
  onData: (ptyId: string, data: string) => void
  onReplay: (ptyId: string, replay: string) => void
  /** Call atSnapshot in stream order; no callback means unreadable, requiring full-screen reattach. */
  reread: (ptyId: string, atSnapshot: (replay: string) => void) => Promise<void>
}

type HiddenPane = {
  dropped: boolean
  revealing: boolean
  salvage: OutputSalvageState
  /** Cursor/mode queries held until the window's screen is current enough to answer them. */
  stateful: string
  resyncing: boolean
}

export class LegacyRelayHiddenOutput {
  private readonly hidden = new Map<string, HiddenPane>()
  /** Finish a visible pane's split escape sequence even if it becomes hidden mid-sequence. */
  private readonly openSequences = new Map<string, OutputSalvageState>()

  constructor(private readonly deps: LegacyRelayHiddenOutputDeps) {}

  onData(ptyId: string, data: string): void {
    const hidden = this.hidden.get(ptyId)
    if (!hidden) {
      this.trackOpenSequence(ptyId, data)
      this.deps.onData(ptyId, data)
      return
    }
    hidden.dropped = true
    const { kept, stateful, state } = salvageHiddenOutput(data, hidden.salvage)
    hidden.salvage = state
    if (kept) {
      this.deps.onData(ptyId, kept)
    }
    if (stateful) {
      hidden.stateful += stateful
      if (!hidden.resyncing) {
        void this.resync(ptyId, hidden)
      }
    }
  }

  setPaused(ptyId: string, paused: boolean): void {
    const hidden = this.hidden.get(ptyId)
    if (paused) {
      if (hidden) {
        hidden.revealing = false
      } else {
        const salvage = this.openSequences.get(ptyId) ?? EMPTY_OUTPUT_SALVAGE
        this.openSequences.delete(ptyId)
        this.hidden.set(ptyId, {
          dropped: false,
          revealing: false,
          salvage,
          stateful: '',
          resyncing: false
        })
      }
      return
    }
    if (!hidden || hidden.revealing) {
      return
    }
    if (!hidden.dropped) {
      this.show(ptyId, hidden, null)
      return
    }
    hidden.revealing = true
    void this.reveal(ptyId, hidden)
  }

  /** An attach snapshot covers all earlier dropped output. */
  screenSent(ptyId: string): void {
    const hidden = this.hidden.get(ptyId)
    if (hidden) {
      hidden.dropped = false
    }
  }

  forget(ptyId: string): void {
    this.hidden.delete(ptyId)
    this.openSequences.delete(ptyId)
  }

  private async reveal(ptyId: string, pane: HiddenPane): Promise<void> {
    // Keep dropping until the snapshot, then send its screen before later bytes.
    await this.deps
      .reread(ptyId, (replay) => {
        if (this.hidden.get(ptyId) === pane && pane.revealing) {
          this.show(ptyId, pane, replay)
        }
      })
      .catch(() => {})
    if (this.hidden.get(ptyId) === pane && pane.revealing) {
      // Unreadable snapshots fall back to full-screen reattach.
      this.show(ptyId, pane, null)
    }
  }

  /** Refresh cursor/mode state before answering queries from hidden output. */
  private async resync(ptyId: string, pane: HiddenPane): Promise<void> {
    pane.resyncing = true
    let answered = false
    await this.deps
      .reread(ptyId, (replay) => {
        if (this.hidden.get(ptyId) === pane && !pane.revealing) {
          answered = true
          pane.dropped = false
          this.deps.onReplay(ptyId, replay)
          this.flushHeld(ptyId, pane)
        }
      })
      .catch(() => {})
    pane.resyncing = false
    if (this.hidden.get(ptyId) !== pane || pane.revealing) {
      return
    }
    if (!answered) {
      // On snapshot failure, a stale answer beats leaving the program blocked.
      this.flushHeld(ptyId, pane)
    } else if (pane.stateful) {
      void this.resync(ptyId, pane)
    }
  }

  private show(ptyId: string, pane: HiddenPane, replay: string | null): void {
    this.hidden.delete(ptyId)
    if (replay !== null) {
      this.deps.onReplay(ptyId, replay)
    }
    this.flushHeld(ptyId, pane)
    // Finish split sequences on reveal; reopen oversized OSC so remaining payload cannot print as text.
    const open = (pane.salvage.skippingOsc ? '\x1b]' : '') + pane.salvage.tail
    if (open) {
      this.deps.onData(ptyId, open)
      this.openSequences.set(ptyId, pane.salvage)
    }
  }

  private flushHeld(ptyId: string, pane: HiddenPane): void {
    if (pane.stateful) {
      const queries = pane.stateful
      pane.stateful = ''
      this.deps.onData(ptyId, queries)
    }
  }

  private trackOpenSequence(ptyId: string, data: string): void {
    const open = this.openSequences.get(ptyId)
    const lastEscape = data.lastIndexOf('\x1b')
    if (!open && lastEscape === -1) {
      return
    }
    // Only the chunk's end can leave a sequence open unless one already spans chunks.
    const { state } = salvageHiddenOutput(
      open || lastEscape === -1 ? data : data.slice(lastEscape),
      open ?? EMPTY_OUTPUT_SALVAGE
    )
    if (state.tail || state.skippingOsc) {
      this.openSequences.set(ptyId, state)
    } else {
      this.openSequences.delete(ptyId)
    }
  }
}
