/**
 * `terminal read` for a worker that IS a structured agent session.
 *
 * Peers peek at each other's recent output constantly, and for a PTY worker that is `terminal
 * read`. A structured worker had no answer at all: `worker-read` demands a dispatch id and
 * coordinator standing a peer does not have, so the only agent-to-agent read verb refused to
 * resolve the handle. This serves the same verb from the session's journal.
 *
 * The result is a plain `RuntimeTerminalRead` — the journal is projected to LINES and paged by the
 * very reader the PTY tail uses — so nothing an agent reads reveals which kind of worker answered,
 * and cursor, limit, `truncated` and `nextCursor` keep their existing meanings.
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
  return readTerminalTail({
    handle: args.handle,
    status: structuredWorkerTerminalState(observeStructuredWorker(identity).status),
    previewLines: lines,
    completedLines: lines,
    // Every projected line is complete; a session journal has no half-written trailing line.
    partialLine: '',
    completedLineCount: lines.length,
    // Older items really were dropped, by the page limit or the byte bound; `truncated` is how the
    // PTY read already says exactly that.
    bufferTruncated: page.hasOlder || bounded.limited,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })
}
