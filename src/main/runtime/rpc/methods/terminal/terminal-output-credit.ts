import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from '../../../../../shared/terminal/protocol/queries/terminal-reply-query-scan'
import type { TerminalOutputMeta } from '../../terminal/terminal-output-frame-chunks'
import { terminalStreamByteLength } from '../../terminal/terminal-stream-byte-length'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type { TerminalOutputChunk } from './terminal-stream-types'

export const TERMINAL_QUERY_REPLAY_MAX_CHARS = 16 * 1024
// Fixed, in code units: the client counts decoded text. The multiplex's 2 MiB max queued ~2 s on an 8 Mbit/s relay.
const OUTPUT_CREDIT_WINDOW_UNITS = 512 * 1024

export type TerminalOutputCredit = {
  deliver: (data: string, meta?: TerminalOutputMeta) => void
  /** Units are UTF-16 code units of Output text the client has parsed since its previous ack. */
  acknowledge: (units: number) => void
  /** A snapshot just sent shows this held output already; drop it instead of replaying it. */
  dropOutputCoveredBySnapshot: (snapshotSeq: number) => void
  /** A snapshot of unknown seq was sent; a recovery replaces held output it may already show. */
  recoverHeldOutput: () => void
  /** Before the final flush. A PTY exit sends held output and later deliveries at once, since no ack or
   * recovery can follow; any other close drops them so the flush can't start a recovery. */
  close: (release: { ptyExited: boolean }) => void
  dispose: () => void
}

/** Bounds Output a client has not parsed yet. Held output past the pending budget is replaced by
 * one current-screen snapshot once the link drains, so a client skips stale output after Ctrl-C. */
export function createTerminalOutputCredit(options: {
  send: (data: string, meta?: TerminalOutputMeta) => void
  /** Resolves the sent snapshot's output seq, or undefined when none was sent. */
  sendRecoverySnapshot: () => Promise<number | undefined>
}): TerminalOutputCredit {
  let inFlightUnits = 0
  let held: TerminalOutputChunk[] = []
  let heldBytes = 0
  let overflowed = false
  let recovering = false
  let draining = false
  let disposed = false
  // Snapshots omit control sequences; replay dropped queries so a waiting TUI still gets its reply.
  let droppedQueries = ''
  let droppedQueriesOverflowed = false
  let queryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE

  const collectDroppedQueries = (chunks: TerminalOutputChunk[]): void => {
    for (const chunk of chunks) {
      if (droppedQueriesOverflowed) {
        return
      }
      const seq = chunk.meta?.seq
      if (typeof seq !== 'number' || chunk.meta?.rawLength !== chunk.data.length) {
        queryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
        continue
      }
      const scan = scanTerminalReplyQuerySequences(
        chunk.data,
        seq - chunk.data.length,
        queryScanState
      )
      queryScanState = scan.state
      for (const query of scan.queries) {
        if (droppedQueries.length + query.data.length > TERMINAL_QUERY_REPLAY_MAX_CHARS) {
          droppedQueriesOverflowed = true
          break
        }
        droppedQueries += query.data
      }
    }
  }

  const replayDroppedQueries = (): void => {
    if (droppedQueries) {
      const bytes = terminalStreamByteLength(droppedQueries)
      held.unshift({ data: droppedQueries, bytes })
      heldBytes += bytes
    }
    droppedQueries = ''
    droppedQueriesOverflowed = false
    queryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  }

  const fits = (units: number): boolean =>
    draining || inFlightUnits === 0 || inFlightUnits + units <= OUTPUT_CREDIT_WINDOW_UNITS

  const trimToBudget = (): void => {
    let dropCount = 0
    while (heldBytes > TERMINAL_MULTIPLEX_PENDING_MAX_BYTES && dropCount < held.length) {
      heldBytes -= held[dropCount]!.bytes
      dropCount += 1
    }
    if (dropCount > 0) {
      collectDroppedQueries(held.splice(0, dropCount))
      overflowed = true
    }
  }

  const dropCovered = (snapshotSeq: number): void => {
    const kept: TerminalOutputChunk[] = []
    const covered: TerminalOutputChunk[] = []
    for (const chunk of held) {
      const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotSeq)
      if (uncovered === chunk) {
        kept.push(chunk)
      } else if (uncovered?.data) {
        const prefix = chunk.data.slice(0, chunk.data.length - uncovered.data.length)
        covered.push({
          data: prefix,
          bytes: 0,
          meta: { seq: snapshotSeq, rawLength: prefix.length }
        })
        kept.push({ ...uncovered, bytes: terminalStreamByteLength(uncovered.data) })
      } else {
        covered.push(chunk)
      }
    }
    collectDroppedQueries(covered)
    held = kept
    heldBytes = kept.reduce((total, chunk) => total + chunk.bytes, 0)
    replayDroppedQueries()
  }

  const recover = async (): Promise<void> => {
    recovering = true
    overflowed = false
    try {
      const snapshotSeq = await options.sendRecoverySnapshot()
      if (disposed) {
        return
      }
      if (typeof snapshotSeq === 'number') {
        dropCovered(snapshotSeq)
      } else {
        replayDroppedQueries()
      }
    } catch {
      // Keep streaming what is held; the next overflow tries again.
    } finally {
      recovering = false
      pump()
    }
  }

  const dispose = (): void => {
    disposed = true
    held = []
  }

  function pump(): void {
    if (disposed || (recovering && !draining)) {
      return
    }
    // A drain sends output past a gap too: no snapshot can follow an exit, and the tail holds the last lines.
    if (!overflowed || draining) {
      let sent = 0
      while (sent < held.length && fits(held[sent]!.data.length)) {
        const chunk = held[sent]!
        inFlightUnits += chunk.data.length
        heldBytes -= chunk.bytes
        sent += 1
        options.send(chunk.data, chunk.meta)
      }
      held.splice(0, sent)
    }
    // Trim after sending so output held across a recovery reaches the client before any new gap.
    trimToBudget()
    // Recover only once the link has drained, so a sustained flood cannot outrun the client with snapshots.
    if (overflowed && !draining && inFlightUnits <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES) {
      void recover()
    }
  }

  return {
    deliver(data, meta) {
      if (disposed) {
        return
      }
      if (!overflowed && !recovering && held.length === 0 && fits(data.length)) {
        inFlightUnits += data.length
        options.send(data, meta)
        return
      }
      const bytes = terminalStreamByteLength(data)
      held.push({ data, bytes, meta })
      heldBytes += bytes
      // During a recovery this returns early: held output follows its snapshot seq, and trimming it would open a new gap.
      pump()
    },
    acknowledge(units) {
      inFlightUnits -= Math.min(inFlightUnits, units)
      pump()
    },
    dropOutputCoveredBySnapshot(snapshotSeq) {
      if (disposed) {
        return
      }
      dropCovered(snapshotSeq)
      pump()
    },
    recoverHeldOutput() {
      if (disposed || held.length === 0) {
        return
      }
      overflowed = true
      pump()
    },
    close({ ptyExited }) {
      if (ptyExited) {
        draining = true
        pump()
      } else {
        dispose()
      }
    },
    dispose
  }
}
