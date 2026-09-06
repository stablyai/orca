/**
 * `terminal read` for a worker that IS a structured agent session.
 *
 * Peers peek at each other's recent output constantly, and for a PTY worker that is `terminal
 * read`. A structured worker had no answer at all: `worker-read` demands a dispatch id and
 * coordinator standing a peer does not have, so the only agent-to-agent read verb refused to
 * resolve the handle. This serves the same verb from the session's journal.
 *
 * The result is a plain `RuntimeTerminalRead` — the journal is projected to LINES and bounded by
 * the very reader the PTY tail uses — so nothing an agent reads reveals which kind of worker
 * answered. `limit` and `truncated` keep their existing meanings.
 *
 * `cursor` does NOT, and is refused rather than approximated. The PTY contract is an index into an
 * append-only completed-line buffer with a monotone count; a session journal is a bounded tail
 * re-projected on every read, so the same index addresses different lines over time and
 * `oldestCursor` can never grow to admit it. Pagination with a real anchor lives on
 * `worker-read --source transcript`.
 *
 * READ ONLY, deliberately. `terminal.show` still refuses a structured handle: synthesising a
 * `ptyId`/`leafId`/`paneRuntimeId` would hand every public terminal verb something that looks
 * writable and is not.
 */

import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { formatWorkerTranscriptMessage } from '../../shared/worker-transcript-text'
import { AGENT_SESSION_NOT_ATTACHED } from '../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import type { OrchestrationDb } from './orchestration/db'
import { boundStructuredJournalTail } from './orchestration/structured-worker-journal-archive'
import { readStructuredJournalPage } from './orchestration/structured-worker-journal-page'
import {
  observeStructuredWorker,
  resolveStructuredWorkerAuthority,
  structuredWorkerTerminalState
} from './structured-worker-authority'
import { readTerminalTail } from './terminal-tail-read'

/**
 * The recent output of a structured worker, or null when this handle is not one.
 *
 * Null is the "not mine" answer, so the PTY path keeps every handle it already owned. A handle that
 * IS a structured worker never falls through: an unreadable journal refuses rather than answering
 * an empty tail, which a caller cannot tell from a worker that has said nothing.
 */
export function readStructuredWorkerTerminal(args: {
  handle: string
  db: OrchestrationDb | null
  cursor?: number
  limit?: number
}): RuntimeTerminalRead | null {
  const identity = resolveStructuredWorkerAuthority(args.handle, args.db)?.identity
  if (!identity) {
    return null
  }
  if (args.cursor !== undefined) {
    // A numeric cursor cannot be re-anchored here. `terminal.read`'s cursor is an index into an
    // append-only completed-line buffer with a monotone count; this window is a BOUNDED tail that
    // is re-projected every read, so the same index means different lines as the journal grows,
    // and `truncated` (`cursor < oldestCursor`) could never fire to say so because `oldestCursor`
    // is always 0. Serving it would silently return wrong or duplicated lines to a poller. The
    // journal does have stable item identity, but the terminal cursor is a number on the wire and
    // cannot carry it — `worker-read --source transcript` already has that contract, including
    // `source_changed` detection.
    throw new Error(
      `${args.handle} serves recent output without a cursor; its history is not line-addressable. ` +
        'Read it without --cursor, or page it with `orca orchestration worker-read --source transcript`.'
    )
  }
  const page = readStructuredJournalPage(identity.sessionId)
  if (!page) {
    // Honest refusal, and the same one the send lane reports: an empty tail would read as "this
    // worker has produced no output", which is a different and false claim.
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  // Redacts dispatch capabilities and clips oversized blocks under the archive path's byte bound.
  const bounded = boundStructuredJournalTail(page.items)
  const lines = bounded.messages.flatMap((message) =>
    formatWorkerTranscriptMessage(message).split('\n')
  )
  const read = readTerminalTail({
    handle: args.handle,
    status: structuredWorkerTerminalState(observeStructuredWorker(identity).status),
    previewLines: lines,
    // Unreachable without a cursor, and deliberately empty rather than a copy of `lines`: a
    // running turn's text is still growing, so calling it "completed" is the `"hel"`/`"hello"`
    // hazard the PTY reader guards against.
    completedLines: [],
    partialLine: '',
    completedLineCount: 0,
    // Older items really were dropped, by the page limit or the byte bound; `truncated` is how the
    // PTY read already says exactly that.
    bufferTruncated: page.hasOlder || bounded.limited,
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })
  // No cursor space is claimed, because none exists here. `nextCursor: null` is the contract's own
  // "nothing to continue from"; emitting 0/length would advertise an index the next read cannot
  // honour.
  const { oldestCursor: _oldest, latestCursor: _latest, ...withoutCursorSpace } = read
  return { ...withoutCursorSpace, nextCursor: null }
}
