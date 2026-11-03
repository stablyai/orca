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
  return {
    sequences,
    record(data: string, meta: RuntimeTerminalDataMeta | undefined) {
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
