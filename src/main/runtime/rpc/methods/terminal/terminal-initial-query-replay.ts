import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQuerySequence
} from '../../../../../shared/terminal-reply-query-scan'
import type { RuntimeTerminalDataMeta } from '../../../orca-runtime'

const TERMINAL_QUERY_REPLAY_MAX_CHARS = 16 * 1024

export function createTerminalInitialQueryReplay() {
  let state = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  const sequences: TerminalReplyQuerySequence[] = []
  let chars = 0
  let overflowed = false
  let recording = true
  return {
    sequences,
    record(data: string, meta: RuntimeTerminalDataMeta | undefined) {
      if (!recording) {
        return
      }
      if (typeof meta?.seq !== 'number' || meta.rawLength !== data.length) {
        state = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
        return
      }
      const scan = scanTerminalReplyQuerySequences(data, meta.seq - meta.rawLength, state)
      state = scan.state
      for (const query of scan.queries) {
        if (chars + query.data.length > TERMINAL_QUERY_REPLAY_MAX_CHARS) {
          overflowed = true
          break
        }
        sequences.push(query)
        chars += query.data.length
      }
    },
    finish(snapshotSeq: number | undefined, outputOverflowed: boolean) {
      recording = false
      const covered = this.covered(snapshotSeq, outputOverflowed)
      sequences.splice(0, sequences.length, ...covered)
      return covered
    },
    settle(seq: number, data: string) {
      const index = sequences.findIndex((query) => query.endSeq === seq && query.data === data)
      if (index !== -1) {
        sequences.splice(index, 1)
      }
      return sequences.length === 0
    },
    covered(snapshotSeq: number | undefined, outputOverflowed: boolean) {
      return overflowed
        ? []
        : sequences.filter(
            (query) =>
              outputOverflowed || (typeof snapshotSeq === 'number' && query.startSeq < snapshotSeq)
          )
    }
  }
}
