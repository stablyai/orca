import { isStatelessRendererReplyCsiQuery } from '../../../../../shared/terminal-reply-query-extraction'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from '../../../../../shared/terminal-reply-query-scan'
import type { RuntimeTerminalDataMeta } from '../../../orca-runtime'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

// Why: half of fish's 10s DA1 wait (fish-shell src/input/decode.rs LONG_READ_TIMEOUT); older replies risk landing at a prompt as junk.
const YIELDED_QUERY_MAX_AGE_MS = 5_000
const YIELDED_QUERY_MAX_ENTRIES = 16

export type YieldedTerminalQuery = { seq: number; data: string; at: number }

/** Record stateless queries main yielded solely to this stream at ingestion, so a later discard can hand them back. */
export function recordYieldedTerminalQueries(
  runtime: TerminalMultiplexConnection['runtime'],
  stream: TerminalMultiplexStream,
  data: string,
  meta: RuntimeTerminalDataMeta | undefined
): void {
  if (
    stream.isMobile ||
    typeof meta?.seq !== 'number' ||
    !runtime.isSoleRemoteTerminalQueryOwner(stream.ptyId)
  ) {
    stream.yieldedQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    return
  }
  // Why: frames split large events with per-slice seqs, so settle by each query's own end seq; transformed text can't map offsets to seq.
  const mapsToSeq = (meta.rawLength ?? data.length) === data.length
  const { queries, state } = scanTerminalReplyQuerySequences(
    data,
    meta.seq - data.length,
    mapsToSeq ? stream.yieldedQueryScan : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  )
  stream.yieldedQueryScan = mapsToSeq ? state : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  const at = Date.now()
  for (const query of queries) {
    if (query.data.startsWith('\x1b[') && isStatelessRendererReplyCsiQuery(query.data)) {
      stream.yieldedQueries.push({ seq: mapsToSeq ? query.endSeq : meta.seq, data: query.data, at })
    }
  }
  if (stream.yieldedQueries.length > YIELDED_QUERY_MAX_ENTRIES) {
    stream.yieldedQueries.splice(0, stream.yieldedQueries.length - YIELDED_QUERY_MAX_ENTRIES)
  }
}

export function settleDeliveredYieldedQueries(
  stream: TerminalMultiplexStream,
  deliveredSeq: number | undefined
): void {
  if (typeof deliveredSeq === 'number' && stream.yieldedQueries.length > 0) {
    stream.yieldedQueries = stream.yieldedQueries.filter((query) => query.seq > deliveredSeq)
  }
}

/** Main answers recent yielded queries the view will now never receive; each was owned by this stream alone. */
export function answerUndeliveredYieldedQueries(
  runtime: TerminalMultiplexConnection['runtime'],
  stream: TerminalMultiplexStream
): void {
  const cutoff = Date.now() - YIELDED_QUERY_MAX_AGE_MS
  const data = stream.yieldedQueries
    .filter((query) => query.at >= cutoff)
    .map((query) => query.data)
    .join('')
  stream.yieldedQueries = []
  stream.yieldedQueryScan = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  if (data) {
    runtime.answerYieldedTerminalQueries(stream.ptyId, data)
  }
}
