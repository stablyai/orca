/** Serve peers' terminal read from the bounded lineage journal using PTY line/limit/truncation projection.
 * Journal items revise in place and epochs reset sequences, so no stable cursor exists; poll and diff the tail.
 * worker-read requires coordinator authority and offers the same mutable window, not a paging alternative.
 * Keep terminal.show non-resolving: fabricated PTY ids would expose writable terminal operations. */

import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { formatWorkerTranscriptMessage } from '../../shared/worker-transcript-text'
import { AGENT_SESSION_NOT_ATTACHED } from '../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import type { OrchestrationDb } from './orchestration/db'
import { boundStructuredJournalTail } from './orchestration/structured-worker-journal-archive'
import { readStructuredLineageJournalPage } from './orchestration/structured-worker-journal-page'
import {
  holdStructuredWorker,
  observeStructuredSession,
  resolveStructuredWorkerIdentity,
  structuredWorkerTerminalState
} from './structured-worker-authority'
import { readTerminalTail } from './terminal-tail-read'

/** Return null for unowned handles so PTY routing continues; held workers with unreadable history or unverified successors must refuse rather than report silence. */
export async function readStructuredWorkerTerminal(args: {
  handle: string
  db: OrchestrationDb | null
  cursor?: number
  limit?: number
}): Promise<RuntimeTerminalRead | null> {
  const identity = resolveStructuredWorkerIdentity(args.handle, args.db)
  if (!identity) {
    return null
  }
  const hold = holdStructuredWorker(identity, args.db)
  if (hold.kind === 'unverifiable') {
    throw hold.refusal
  }
  if (hold.kind === 'not-held') {
    return null
  }
  if (args.cursor !== undefined) {
    // Mutable journal projection cannot honor append-only PTY cursors; worker-read has neither a stable anchor nor peer authorization.
    throw new Error(
      `${args.handle} serves recent output without a cursor; its history is not line-addressable. ` +
        'Read it without --cursor: the tail is bounded and newest-last, so poll it and diff. ' +
        'A structured session has no durable line anchor to page from — nothing else does either.'
    )
  }
  const page = await readStructuredLineageJournalPage(hold.running.lineage)
  if (!page) {
    // An unreadable journal cannot honestly report an empty tail.
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  // Redacts dispatch capabilities and clips oversized blocks under the archive path's byte bound.
  const bounded = boundStructuredJournalTail(page.items)
  const lines = bounded.messages.flatMap((message) =>
    formatWorkerTranscriptMessage(message).split('\n')
  )
  const read = readTerminalTail({
    handle: args.handle,
    status: structuredWorkerTerminalState(observeStructuredSession(hold.running.sessionId).status),
    previewLines: lines,
    // Growing turn text is not completed output; without cursors these fields remain unreachable.
    completedLines: [],
    partialLine: '',
    completedLineCount: 0,
    // Propagate truncation from page limits, byte bounds or unreadable earlier sessions.
    bufferTruncated: page.hasOlder || bounded.limited,
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })
  // No stable line space exists; nextCursor null must not advertise one.
  const { oldestCursor: _oldest, latestCursor: _latest, ...withoutCursorSpace } = read
  return { ...withoutCursorSpace, nextCursor: null }
}
