import type {
  RuntimeTerminalClientPaste,
  RuntimeTerminalClientPasteReceipt
} from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'

type ReceiptRecord = {
  seq: number
  state: 'writing' | 'refused' | 'written' | 'withdrawn'
  /** Last input generation once the paste finished writing. */
  inputGeneration?: number
  /** `Date.now()` by which a still-writing paste should have settled; unknown until estimated. */
  settlesAt?: number
}

/** Why bounded: one record per client window that pasted into this process; a window keeps only its latest. */
const MAX_LANES_PER_PTY = 16

/** What became of each client's latest paste into a PTY, so a client that lost a paste's reply can
 *  learn whether its text reached the terminal. Asking about a paste the host never saw withdraws
 *  it: if that request arrives later, it is refused before writing. */
export class TerminalClientPasteReceipts {
  private readonly byPtyId = new Map<string, Map<string, ReceiptRecord>>()
  // Why: an evicted lane's paste may have written, so "never seen" no longer proves it did not.
  private readonly evictedPtyIds = new Set<string>()

  /** Call synchronously before the paste may write. Null: withdrawn or superseded, write nothing. */
  claim(
    ptyId: string,
    paste: RuntimeTerminalClientPaste
  ): {
    estimateSettle: (settleMs: number) => void
    finish: (handedOff: boolean, inputGeneration: number) => void
  } | null {
    const lanes = this.byPtyId.get(ptyId) ?? new Map<string, ReceiptRecord>()
    const prior = lanes.get(paste.lane)
    if (prior && prior.seq >= paste.seq) {
      return null
    }
    const record: ReceiptRecord = { seq: paste.seq, state: 'writing' }
    this.setRecord(ptyId, lanes, paste.lane, record)
    return {
      estimateSettle: (settleMs) => {
        record.settlesAt = Date.now() + settleMs
      },
      finish: (handedOff, inputGeneration) => {
        if (record.state !== 'writing') {
          return
        }
        record.state = handedOff ? 'written' : 'refused'
        record.inputGeneration = inputGeneration
      }
    }
  }

  /** Answers for one paste; a paste not yet seen is withdrawn so it can never write afterwards. */
  reconcile(
    ptyId: string,
    paste: RuntimeTerminalClientPaste,
    writtenSettlesAt: number | undefined,
    now = Date.now()
  ): RuntimeTerminalClientPasteReceipt {
    const lanes = this.byPtyId.get(ptyId) ?? new Map<string, ReceiptRecord>()
    const record = lanes.get(paste.lane)
    if (!record || record.seq < paste.seq) {
      const evicted = !record && this.evictedPtyIds.has(ptyId)
      this.setRecord(ptyId, lanes, paste.lane, { seq: paste.seq, state: 'withdrawn' })
      return { state: evicted ? 'unknown' : 'withdrawn' }
    }
    if (record.seq > paste.seq) {
      // This window pasted again since; its answer about the older paste is gone.
      return { state: 'unknown' }
    }
    switch (record.state) {
      case 'writing':
        return {
          state: 'writing',
          settlesInMs: Math.max(0, (record.settlesAt ?? now) - now)
        }
      case 'written':
        return {
          state: 'written',
          inputGeneration: record.inputGeneration!,
          settlesInMs: Math.max(0, (writtenSettlesAt ?? now) - now)
        }
      case 'refused':
        return { state: 'refused' }
      case 'withdrawn':
        return { state: 'withdrawn' }
    }
  }

  forget(ptyId: string): void {
    this.byPtyId.delete(ptyId)
    this.evictedPtyIds.delete(ptyId)
  }

  private setRecord(
    ptyId: string,
    lanes: Map<string, ReceiptRecord>,
    lane: string,
    record: ReceiptRecord
  ): void {
    // Re-insert so the map's order is least recently used first.
    lanes.delete(lane)
    lanes.set(lane, record)
    if (lanes.size > MAX_LANES_PER_PTY) {
      lanes.delete(lanes.keys().next().value!)
      this.evictedPtyIds.add(ptyId)
    }
    this.byPtyId.set(ptyId, lanes)
  }
}
