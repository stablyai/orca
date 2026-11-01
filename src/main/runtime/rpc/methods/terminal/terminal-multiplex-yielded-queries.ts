import { isStatelessRendererReplyCsiQuery } from '../../../../../shared/terminal-reply-query-extraction'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from '../../../../../shared/terminal-reply-query-scan'
import type { RuntimeTerminalDataMeta } from '../../../orca-runtime'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'
import { encodeTerminalStreamText } from '../../../../../shared/terminal-stream-protocol'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'

// Why: half of fish's 10s DA1 wait (fish-shell src/input/decode.rs LONG_READ_TIMEOUT); older replies risk landing at a prompt as junk.
const YIELDED_QUERY_MAX_AGE_MS = 5_000
const YIELDED_QUERY_MAX_ENTRIES = 16

/** `discarded`: main dropped the carrying output unsent, so the next covering snapshot owes the replay. */
export type YieldedTerminalQuery = { seq: number; data: string; at: number; discarded?: true }

type ReplayedTerminalQuery = { seq: number; data: string }

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

export function settleReplayedYieldedQuery(
  stream: TerminalMultiplexStream,
  replayedQuery: ReplayedTerminalQuery
): void {
  const index = findYieldedQuery(stream, replayedQuery)
  if (index !== -1) {
    stream.yieldedQueries.splice(index, 1)
  }
}

function findYieldedQuery(stream: TerminalMultiplexStream, target: ReplayedTerminalQuery): number {
  return stream.yieldedQueries.findIndex(
    (query) => query.seq === target.seq && query.data === target.data
  )
}

function markYieldedQueriesDiscarded(
  stream: TerminalMultiplexStream,
  throughSeq = Number.POSITIVE_INFINITY
): void {
  for (const query of stream.yieldedQueries) {
    if (query.seq <= throughSeq) {
      query.discarded = true
    }
  }
}

/** Drop snapshot-buffered output unsent; its owed queries replay after the next covering snapshot. */
export function discardPendingMultiplexOutput(stream: TerminalMultiplexStream): void {
  markYieldedQueriesDiscarded(stream)
  stream.pendingOutput.splice(0)
  stream.pendingOutputBytes = 0
  stream.pendingOutputOverflowed = false
}

/** ACK-queued frames dropped unsent (overflow trim, recovery cutoff) can no longer settle their queries. */
export function markYieldedQueriesDiscardedInFrames(
  stream: TerminalMultiplexStream,
  frames: readonly TerminalOutputFrameChunk[]
): void {
  let throughSeq: number | undefined
  for (const frame of frames) {
    if (typeof frame.seq === 'number') {
      throughSeq = Math.max(throughSeq ?? frame.seq, frame.seq)
    }
    const replayedIndex = frame.replayedQuery ? findYieldedQuery(stream, frame.replayedQuery) : -1
    if (replayedIndex !== -1) {
      stream.yieldedQueries[replayedIndex]!.discarded = true
    }
  }
  if (typeof throughSeq === 'number') {
    markYieldedQueriesDiscarded(stream, throughSeq)
  }
}

function isSnapshotQueryReplayFrame(frame: TerminalOutputFrameChunk): boolean {
  return frame.replayedQuery !== undefined || frame.replayedEscapeTail === true
}

/** Replays still queued for an older snapshot would re-enter its stale escape tail; the newer snapshot re-replays them. */
function purgeQueuedSnapshotQueryReplays(stream: TerminalMultiplexStream): void {
  const purged = stream.ackPendingOutput.filter(isSnapshotQueryReplayFrame)
  if (purged.length === 0) {
    return
  }
  stream.ackPendingOutput = stream.ackPendingOutput.filter(
    (frame) => !isSnapshotQueryReplayFrame(frame)
  )
  for (const frame of purged) {
    stream.ackPendingOutputBytes -= frame.bytes.byteLength
  }
  markYieldedQueriesDiscardedInFrames(stream, purged)
}

/** Snapshots preserve cells, not queries; replay covered stateless queries through the viewer's ordered parser. */
export function replaySnapshotCoveredStatelessQueries(
  connection: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  chunks: readonly TerminalOutputChunk[],
  snapshotSeq: number | undefined,
  pendingEscapeTailAnsi?: string
): void {
  if (typeof snapshotSeq !== 'number') {
    return
  }
  purgeQueuedSnapshotQueryReplays(stream)
  if (stream.yieldedQueries.length === 0) {
    return
  }
  const isDiscardedCovered = (query: YieldedTerminalQuery): boolean =>
    query.discarded === true && query.seq <= snapshotSeq
  const cutoff = Date.now() - YIELDED_QUERY_MAX_AGE_MS
  // Late replies to long-dropped queries would land at a prompt as junk.
  stream.yieldedQueries = stream.yieldedQueries.filter(
    (query) => !isDiscardedCovered(query) || query.at >= cutoff
  )
  const replays: ReplayedTerminalQuery[] = stream.yieldedQueries
    .filter(isDiscardedCovered)
    .map(({ seq, data }) => ({ seq, data }))
  const remainingQueries = stream.yieldedQueries.filter((query) => !isDiscardedCovered(query))
  let scanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  for (const chunk of chunks) {
    const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotSeq)
    const seq = chunk.meta?.seq
    if (typeof seq !== 'number' || uncovered === chunk) {
      scanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
      continue
    }
    const rawLength = chunk.meta?.rawLength ?? chunk.data.length
    const startSeq = seq - rawLength
    const coveredLength = chunk.data.length - (uncovered?.data.length ?? 0)
    const mapsToSeq = rawLength === chunk.data.length && !chunk.meta?.transformed
    const scan = scanTerminalReplyQuerySequences(
      chunk.data.slice(0, coveredLength),
      startSeq,
      mapsToSeq ? scanState : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    scanState = mapsToSeq ? scan.state : EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    for (const query of scan.queries) {
      const querySeq = mapsToSeq ? query.endSeq : seq
      const owedIndex = remainingQueries.findIndex(
        (owed) => owed.seq === querySeq && owed.data === query.data
      )
      if (isStatelessRendererReplyCsiQuery(query.data) && owedIndex !== -1) {
        remainingQueries.splice(owedIndex, 1)
        replays.push({ seq: querySeq, data: query.data })
      }
    }
  }
  if (replays.length === 0) {
    return
  }
  // Seq-less output survives the viewer's snapshot cutoff; retain host-only settlement until actually sent.
  const frames: TerminalOutputFrameChunk[] = replays.map((query, index) => {
    const data = index === 0 && pendingEscapeTailAnsi ? `\x18${query.data}` : query.data
    return {
      bytes: encodeTerminalStreamText(data),
      displayLength: data.length,
      replayedQuery: query
    }
  })
  if (pendingEscapeTailAnsi) {
    // Cancel only the snapshot's partial parser command around queries, then restore it for the untouched live suffix.
    frames.push({
      bytes: encodeTerminalStreamText(pendingEscapeTailAnsi),
      displayLength: pendingEscapeTailAnsi.length,
      replayedEscapeTail: true
    })
  }
  if (
    stream.outputPaused ||
    (stream.ackPendingOutput.length === 0 && !stream.ackPendingOutputOverflowed)
  ) {
    for (const frame of frames) {
      connection.queueOrSendOutput(stream, frame)
    }
    return
  }
  // Snapshots bypass the ACK queue; replays must lead it to follow the snapshot, not output queued before it.
  stream.ackPendingOutput.unshift(...frames)
  for (const frame of frames) {
    stream.ackPendingOutputBytes += frame.bytes.byteLength
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
