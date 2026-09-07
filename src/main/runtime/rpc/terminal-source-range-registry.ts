import { TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION } from '../../../shared/terminal-multiplex-flow-control'
import {
  TerminalSourceRangeLedger,
  type TerminalSourceRangeBudget
} from './terminal-source-range-ledger'

export const TERMINAL_SOURCE_RANGE_CONNECTION_MAX_BYTES = 16 * 1024 * 1024

export class TerminalSourceRangeRegistry {
  private readonly ledgers = new Set<TerminalSourceRangeLedger>()
  private retainedBytes = 0

  open(streamGeneration: string): TerminalSourceRangeLedger | null {
    if (this.ledgers.size >= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION) {
      return null
    }
    let ledger: TerminalSourceRangeLedger
    const budget: TerminalSourceRangeBudget = {
      canReserve: (bytes) =>
        this.retainedBytes + bytes <= TERMINAL_SOURCE_RANGE_CONNECTION_MAX_BYTES,
      reserve: (bytes) => {
        if (this.retainedBytes + bytes > TERMINAL_SOURCE_RANGE_CONNECTION_MAX_BYTES) {
          return false
        }
        this.retainedBytes += bytes
        return true
      },
      release: (bytes) => {
        this.retainedBytes = Math.max(0, this.retainedBytes - bytes)
      },
      close: () => {
        this.ledgers.delete(ledger)
      }
    }
    ledger = new TerminalSourceRangeLedger(streamGeneration, budget)
    this.ledgers.add(ledger)
    return ledger
  }

  getDebugSnapshot() {
    return { streams: this.ledgers.size, retainedBytes: this.retainedBytes }
  }
}
