/**
 * Bridged panes no visible view shows: their output stops here instead of crossing renderer IPC,
 * and the reveal re-reads the screen the relay kept, since main holds no model of these terminals.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  EMPTY_OUTPUT_SALVAGE,
  salvageHiddenOutput,
  type OutputSalvageState
} from './legacy-relay-output-salvage'

export type LegacyRelayHiddenOutputDeps = {
  onData: (ptyId: string, data: string) => void
  /** A whole screen that replaces what the pane shows. */
  onReplay: (ptyId: string, replay: string) => void
  /**
   * Re-reads the relay's screen, calling `atSnapshot` in stream order with it. Never calling it
   * means the screen could not be read; the bridge then reattaches the pane with a full screen.
   */
  reread: (ptyId: string, atSnapshot: (replay: string) => void) => Promise<void>
}

/** Present while output is dropped; `revealing` once a view wants it and its screen is on the way. */
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
  /** A sequence a shown pane's last chunk left open, so a pause mid-sequence still finishes it. */
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

  /** At an attach's snapshot: what was dropped before it is in the screen that attach returns. */
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
    // Why output stays dropped until the snapshot: everything before it is in the screen, and the
    // screen must reach the window before anything printed after it.
    await this.deps
      .reread(ptyId, (replay) => {
        if (this.hidden.get(ptyId) === pane && pane.revealing) {
          this.show(ptyId, pane, replay)
        }
      })
      .catch(() => {})
    if (this.hidden.get(ptyId) === pane && pane.revealing) {
      // Unreadable: the pane goes live again, and its reattach brings the whole screen.
      this.show(ptyId, pane, null)
    }
  }

  /** Brings a hidden pane's screen current so a cursor or mode query is answered truthfully. */
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
      // Unreadable: a stale answer beats a program waiting forever.
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
    // A sequence split where output was dropped; the next live chunk finishes it. An oversized OSC
    // is reopened so its remaining payload parses as one instead of printing as text.
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
    // Only the chunk's end can leave a sequence open, unless one already spans chunks.
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
